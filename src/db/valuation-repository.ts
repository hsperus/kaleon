/**
 * Değerleme deposu — maliyet durumu ve döviz kuru.
 *
 * MALİYET HAREKETLE AYNI İŞLEMDE GÜNCELLENİR. Ayrı yapılsaydı, aradaki bir
 * çökme stoğu artırıp maliyeti eski bırakır; sonraki her hesap sessizce
 * yanlış olurdu ve hata ancak envanter sayımında görünürdü.
 *
 * MALİYET SATIRI KİLİTLENİR. İki eşzamanlı giriş aynı ortalamayı okuyup
 * ikisi de kendi hesabını yazarsa biri kaybolur — ve kaybolan, ortalamayı
 * kalıcı olarak yanlış bırakır. Sipariş kilidiyle aynı gerekçe.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { toMoney, toQuantity } from "./decimal.js";
import { assertPeriodOpen } from "./period-repository.js";
import { JournalRepository } from "./journal-repository.js";
import { goodsReceiptLines } from "../modules/accounting/posting-rules.js";
import {
  pickRate,
  toBaseCurrency,
  ExchangeRateError,
  type RateQuote,
} from "../modules/finance/exchange.js";
import {
  applyIssue,
  applyReceipt,
  valueOnHand,
  type StockValue,
} from "../modules/inventory/valuation.js";

type Tx = Prisma.TransactionClient;

export interface MovementCost {
  readonly unitCost: number | null;
  readonly value: number | null;
}

export class ValuationRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /** İşlem tarihine uygun kuru bulur. Yoksa hata — 1 varsayılmaz. */
  async rateFor(currency: string, on: Date): Promise<RateQuote> {
    if (currency === "TRY") return pickRate([], "TRY", on);

    // Yalnızca geriye bakan ve en yakın olan birkaç satır okunur; tüm
    // kur tarihçesini belleğe almak gereksizdir.
    const rows = await this.#db.exchangeRate.findMany({
      where: { currency, quotedAt: { lte: on } },
      orderBy: { quotedAt: "desc" },
      take: 1,
    });

    return pickRate(
      rows.map((r) => ({ rate: Number(r.rate), quotedAt: r.quotedAt, source: r.source })),
      currency,
      on,
    );
  }

  /** Yabancı para tutarı, işlem tarihindeki kurla TL'ye çevirir. */
  async toTry(
    amount: number,
    currency: string,
    on: Date,
  ): Promise<{ amount: number; rate: number; quotedAt: string }> {
    return toBaseCurrency(amount, await this.rateFor(currency, on));
  }

  async saveRate(input: {
    currency: string;
    rate: number;
    quotedAt: Date;
    source?: string;
  }): Promise<void> {
    if (!(input.rate > 0)) {
      throw new ExchangeRateError(`Geçersiz kur: ${input.rate}`);
    }
    // Aynı gün için ikinci bir ilan, öncekini GÜNCELLER: TCMB gün içinde
    // düzeltme yayımlayabilir ve iki farklı "resmî kur" tutulamaz.
    await this.#db.exchangeRate.upsert({
      where: { currency_quotedAt: { currency: input.currency, quotedAt: input.quotedAt } },
      create: {
        currency: input.currency,
        rate: new Prisma.Decimal(input.rate),
        quotedAt: input.quotedAt,
        source: input.source ?? "TCMB",
      },
      update: {
        rate: new Prisma.Decimal(input.rate),
        source: input.source ?? "TCMB",
      },
    });
  }

  /** Bir malzemenin güncel maliyet durumu. */
  async costOf(itemId: string): Promise<StockValue> {
    const row = await this.#db.itemCostState.findUnique({ where: { itemId } });
    if (!row) return valueOnHand(0, null);
    return valueOnHand(toQuantity(row.quantityOnHand as never) ?? 0, toMoney(row.unitCost as never));
  }

  /**
   * Mal girişi kaydeder ve hareketli ortalamayı günceller.
   *
   * Yabancı para alımda maliyet ÖNCE TL'ye çevrilir: ortalama tek para
   * biriminde tutulmazsa EUR ve TL maliyetler toplanır ve sonuç anlamsız olur.
   */
  async postReceipt(input: {
    itemId: string;
    locationId: string;
    quantity: number;
    unitCost: number;
    currency?: string;
    at: Date;
    userId: string;
    referenceKind?: string;
    referenceId?: string;
    batchId?: string | null;
    /**
     * Satıcı carisi ve KDV — verilirse mal kabulü MUHASEBELEŞİR.
     *
     * Verilmezse yalnızca stok ve maliyet güncellenir: açılış stoğu ve
     * üretimden giriş gibi hareketlerin satıcısı yoktur ve 320'ye kayıt
     * atmak yanlış olurdu.
     */
    partnerId?: string | null;
    vatAmount?: number;
  }): Promise<{
    unitCost: number;
    quantityOnHand: number;
    value: number;
    rate: number | null;
    caveat: string | null;
  }> {
    const currency = input.currency ?? "TRY";
    const quote = await this.rateFor(currency, input.at);
    const costTry = toBaseCurrency(input.unitCost, quote).amount;

    return this.#db.$transaction(async (tx) => {
      await assertPeriodOpen(tx, input.at, "Mal kabulü");
      const state = await lockCostState(tx, input.itemId);
      const next = applyReceipt(
        { quantityOnHand: state.quantityOnHand, unitCost: state.unitCost },
        { quantity: input.quantity, unitCost: costTry },
      );

      const movement = await tx.stockMovement.create({
        data: {
          at: input.at,
          itemId: input.itemId,
          locationId: input.locationId,
          batchId: input.batchId ?? null,
          quantity: new Prisma.Decimal(input.quantity),
          direction: 1,
          movementType: "mal_kabul",
          referenceKind: input.referenceKind ?? null,
          referenceId: input.referenceId ?? null,
          userId: input.userId,
          unitCost: new Prisma.Decimal(costTry),
          value: new Prisma.Decimal(next.valueIn),
          sourceCurrency: currency === "TRY" ? null : currency,
          exchangeRate: currency === "TRY" ? null : new Prisma.Decimal(quote.rate),
        },
      });

      await writeCostState(tx, input.itemId, next.quantityOnHand, next.unitCost);

      if (input.partnerId) {
        const item = await tx.item.findUnique({
          where: { code: input.itemId },
          select: { type: true },
        });
        await JournalRepository.postIn(tx, {
          entryDate: input.at,
          description: `${input.referenceId ?? input.itemId} mal kabulü`,
          sourceKind: "goods_receipt",
          sourceId: movement.id,
          lines: goodsReceiptLines({
            documentNo: input.referenceId ?? input.itemId,
            partnerId: input.partnerId,
            itemType: item?.type ?? "hammadde",
            netAmount: next.valueIn,
            vatAmount: input.vatAmount ?? 0,
          }),
          userId: input.userId,
        });
      }

      return {
        unitCost: next.unitCost,
        quantityOnHand: next.quantityOnHand,
        value: next.valueIn,
        rate: currency === "TRY" ? null : quote.rate,
        caveat: next.caveat,
      };
    });
  }

  /**
   * Çıkışı değerler ve bakiyeyi düşer.
   *
   * Hareket kaydı ÇAĞIRANA AİTTİR (sevkiyat kendi kaydını yazar); burada
   * yalnızca maliyet ve bakiye güncellenir ve hareketin değeri döner.
   * Böylece aynı çıkış iki kez yazılmaz.
   */
  async valueIssue(
    tx: Tx,
    itemId: string,
    quantity: number,
  ): Promise<MovementCost> {
    const state = await lockCostState(tx, itemId);
    const out = applyIssue({ quantityOnHand: state.quantityOnHand, unitCost: state.unitCost }, quantity);
    await writeCostState(tx, itemId, out.quantityOnHand, out.unitCost);
    return { unitCost: out.unitCost, value: out.valueOut };
  }

  /** Çıkışın geri alınması: bakiye geri eklenir, ortalama DEĞİŞMEZ. */
  async reverseIssue(tx: Tx, itemId: string, quantity: number): Promise<void> {
    const state = await lockCostState(tx, itemId);
    await writeCostState(tx, itemId, state.quantityOnHand + quantity, state.unitCost);
  }

  /**
   * Toplam envanter değeri.
   *
   * MALİYETİ BİLİNMEYEN KALEMLER TOPLAMA GİRMEZ, AYRI SAYILIR. Sıfırla
   * toplansaydı envanter değeri olduğundan düşük çıkar ve bilanço yanlış
   * olurdu — üstelik hiçbir uyarı vermeden.
   */
  async inventoryValue(): Promise<{
    totalValue: number;
    valuedItems: number;
    unvaluedItems: number;
    unvaluedCodes: readonly string[];
  }> {
    const rows = await this.#db.itemCostState.findMany({
      where: { quantityOnHand: { not: 0 } },
    });

    let totalValue = 0;
    let valued = 0;
    const unvalued: string[] = [];

    for (const r of rows) {
      const v = valueOnHand(
        toQuantity(r.quantityOnHand as never) ?? 0,
        toMoney(r.unitCost as never),
      );
      if (v.value === null) {
        unvalued.push(r.itemId);
      } else {
        totalValue += v.value;
        valued += 1;
      }
    }

    return {
      totalValue: Math.round(totalValue * 100) / 100,
      valuedItems: valued,
      unvaluedItems: unvalued.length,
      unvaluedCodes: unvalued.slice(0, 20),
    };
  }
}

/** Maliyet satırını kilitler; yoksa oluşturur. */
async function lockCostState(
  tx: Tx,
  itemId: string,
): Promise<{ quantityOnHand: number; unitCost: number | null }> {
  await tx.$executeRaw`
    INSERT INTO "item_cost_states" ("id", "item_id", "quantity_on_hand", "updated_at")
    VALUES (gen_random_uuid(), ${itemId}, 0, NOW())
    ON CONFLICT ("item_id") DO NOTHING`;

  const rows = await tx.$queryRaw<{ quantity_on_hand: string; unit_cost: string | null }[]>`
    SELECT "quantity_on_hand", "unit_cost" FROM "item_cost_states"
     WHERE "item_id" = ${itemId} FOR UPDATE`;

  const row = rows[0];
  if (!row) throw new Error(`Maliyet durumu okunamadı: ${itemId}`);
  return {
    quantityOnHand: Number(row.quantity_on_hand),
    unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
  };
}

async function writeCostState(
  tx: Tx,
  itemId: string,
  quantity: number,
  unitCost: number | null,
): Promise<void> {
  const value = unitCost === null ? null : Math.round(quantity * unitCost * 100) / 100;
  await tx.itemCostState.update({
    where: { itemId },
    data: {
      quantityOnHand: new Prisma.Decimal(quantity),
      unitCost: unitCost === null ? null : new Prisma.Decimal(unitCost),
      totalValue: value === null ? null : new Prisma.Decimal(value),
    },
  });
}
