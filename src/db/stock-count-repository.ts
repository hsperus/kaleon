/**
 * Stok sayımı deposu.
 *
 * SAYIM AÇILDIĞI ANDA SİSTEM MİKTARI VE MALİYETİ DONDURULUR. Sayım
 * kaydedilirken okunsaydı, aradaki her hareket farkı değiştirir ve
 * depocunun doğru saydığı bir kalem hatalı görünürdü — üstelik neden
 * hatalı göründüğü de anlaşılamazdı.
 *
 * KAYIT ÜÇ ŞEYİ BİRLİKTE YAPAR: stok hareketi, maliyet güncellemesi ve
 * muhasebe fişi. Ayrı yapılsaydı, aradaki bir çökme stoğu düzeltip
 * muhasebeyi düzeltmez ve bilanço ile depo birbirini tutmazdı.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { nextDocumentNo } from "./sales-repository.js";
import { assertPeriodOpen } from "./period-repository.js";
import { JournalRepository } from "./journal-repository.js";
import { stockCountDifferenceLines } from "../modules/accounting/posting-rules.js";
import {
  assertPostable,
  differenceOf,
  summarize,
  StockCountError,
  type CountLine,
  type CountStatus,
} from "../modules/inventory/stock-count.js";

export interface CountView {
  readonly documentNo: string;
  readonly locationId: string;
  readonly countDate: string;
  readonly status: CountStatus;
  readonly blind: boolean;
  readonly lines: readonly {
    lineNo: number;
    itemCode: string;
    batchId: string | null;
    /** KÖR SAYIMDA GİZLENİR: sayan kişi sistemdeki miktarı görmemeli. */
    systemQty: number | null;
    countedQty: number | null;
  }[];
}

export class StockCountRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Sayım açar: o andaki bakiyeleri ve maliyetleri DONDURUR.
   *
   * Malzeme listesi verilmezse depodaki bakiyesi olan tüm kalemler alınır.
   * Bakiyesi sıfır olanlar da dahil edilir: "hiç yok" ile "sayılmadı"
   * farklı şeylerdir ve sayımın işi bunu ayırt etmektir.
   */
  async open(input: {
    locationId: string;
    countDate: Date;
    userId: string;
    blind?: boolean;
    itemCodes?: readonly string[];
    note?: string | null;
  }): Promise<CountView> {
    return this.#db.$transaction(async (tx) => {
      const balances = await tx.itemCostState.findMany({
        ...(input.itemCodes && input.itemCodes.length > 0
          ? { where: { itemId: { in: [...input.itemCodes] } } }
          : {}),
        orderBy: { itemId: "asc" },
        take: 2000,
      });

      if (balances.length === 0) {
        throw new StockCountError(
          "Sayılacak kalem bulunamadı. Depoda hiç stok kaydı yoksa sayım açmak anlamsızdır.",
        );
      }

      const documentNo = await nextDocumentNo(tx, "stock_count", input.countDate.getUTCFullYear());

      const count = await tx.stockCount.create({
        data: {
          documentNo,
          locationId: input.locationId,
          countDate: input.countDate,
          status: "open",
          blind: input.blind ?? true,
          countedBy: input.userId,
          note: input.note ?? null,
          lines: {
            create: balances.map((b, i) => ({
              lineNo: i + 1,
              itemId: b.itemId,
              systemQty: b.quantityOnHand,
              unitCost: b.unitCost,
            })),
          },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });

      return toView(count);
    });
  }

  async byNo(documentNo: string): Promise<CountView | null> {
    const row = await this.#db.stockCount.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    return row ? toView(row) : null;
  }

  /** Sayılan miktarları yazar. */
  async record(
    documentNo: string,
    counts: readonly { lineNo: number; countedQty: number }[],
  ): Promise<{ counted: number; remaining: number }> {
    return this.#db.$transaction(async (tx) => {
      const count = await tx.stockCount.findUnique({
        where: { documentNo },
        include: { lines: true },
      });
      if (!count) throw new StockCountError(`Sayım bulunamadı: ${documentNo}`);
      if (count.status !== "open") {
        throw new StockCountError(`${documentNo} ${count.status} durumunda; miktar girilemez.`);
      }

      const byLine = new Map(count.lines.map((l) => [l.lineNo, l]));
      for (const c of counts) {
        const line = byLine.get(c.lineNo);
        if (!line) {
          throw new StockCountError(`${documentNo} sayımında ${c.lineNo} numaralı kalem yok.`);
        }
        if (c.countedQty < 0) {
          throw new StockCountError(
            `Kalem ${c.lineNo}: sayılan miktar negatif olamaz. Fiziksel bir sayımda ` +
              `eksi adet yoktur; bu bir giriş hatasıdır.`,
          );
        }
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: { countedQty: new Prisma.Decimal(c.countedQty), countedAt: new Date() },
        });
      }

      const fresh = await tx.stockCountLine.findMany({ where: { countId: count.id } });
      const remaining = fresh.filter((l) => l.countedQty === null).length;
      if (remaining === 0) {
        await tx.stockCount.update({ where: { id: count.id }, data: { status: "counted" } });
      }

      return { counted: fresh.length - remaining, remaining };
    });
  }

  /** Farkları ve tekrar sayım gerektirenleri döndürür. */
  async differences(documentNo: string) {
    const count = await this.#db.stockCount.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!count) throw new StockCountError(`Sayım bulunamadı: ${documentNo}`);

    const lines = toCountLines(count.lines);
    return {
      documentNo,
      status: count.status as CountStatus,
      differences: lines.map(differenceOf).filter((d): d is NonNullable<typeof d> => d !== null),
      summary: summarize(lines),
    };
  }

  /**
   * Sayımı kaydeder: stok düzeltmesi + maliyet + muhasebe fişi.
   *
   * Fark satırı yoksa hareket de fiş de üretilmez: "sayım tuttu" durumunda
   * boş bir fiş açmak, defteri anlamsız kayıtlarla doldurur.
   */
  async post(input: {
    documentNo: string;
    userId: string;
    /** Tekrar sayım eşiğini aşan farklar kabul edilsin mi. */
    acceptLargeDifferences?: boolean;
  }): Promise<{
    documentNo: string;
    adjustedLines: number;
    netValueDifference: number;
    journalNo: string | null;
  }> {
    return this.#db.$transaction(async (tx) => {
      const count = await tx.stockCount.findUnique({
        where: { documentNo: input.documentNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!count) throw new StockCountError(`Sayım bulunamadı: ${input.documentNo}`);

      const lines = toCountLines(count.lines);
      assertPostable(lines, count.status as CountStatus, {
        ...(input.acceptLargeDifferences ? { allowRecountOverride: true } : {}),
      });
      await assertPeriodOpen(tx, count.countDate, "Sayım düzeltmesi");

      const diffs = lines
        .map(differenceOf)
        .filter((d): d is NonNullable<typeof d> => d !== null && d.difference !== 0);

      const journalLines = [];
      for (const d of diffs) {
        const line = count.lines.find((l) => l.lineNo === d.lineNo)!;

        // STOK HAREKETİ HER FARK İÇİN YAZILIR — değeri bilinmese bile.
        // Yazılmasaydı bakiye sayımla uyuşmaz ve bir sonraki sayım aynı
        // farkı yeniden bulurdu.
        await tx.stockMovement.create({
          data: {
            at: count.countDate,
            itemId: d.itemCode,
            locationId: count.locationId,
            batchId: line.batchId,
            quantity: new Prisma.Decimal(Math.abs(d.difference)),
            direction: d.difference > 0 ? 1 : -1,
            movementType: "sayim_farki",
            referenceKind: "stock_count",
            referenceId: count.id,
            userId: input.userId,
            reason: `${input.documentNo} sayım farkı`,
            ...(line.unitCost !== null
              ? {
                  unitCost: line.unitCost,
                  value: new Prisma.Decimal(Math.abs(d.valueDifference ?? 0)),
                }
              : {}),
          },
        });

        await tx.itemCostState.update({
          where: { itemId: d.itemCode },
          data: { quantityOnHand: new Prisma.Decimal(d.countedQty) },
        });

        if (d.valueDifference !== null && d.valueDifference !== 0) {
          const item = await tx.item.findUnique({
            where: { code: d.itemCode },
            select: { type: true },
          });
          journalLines.push(
            ...stockCountDifferenceLines({
              documentNo: input.documentNo,
              itemType: item?.type ?? "hammadde",
              valueDifference: d.valueDifference,
            }),
          );
        }
      }

      let journalNo: string | null = null;
      if (journalLines.length > 0) {
        const entry = await JournalRepository.postIn(tx, {
          entryDate: count.countDate,
          description: `${input.documentNo} stok sayım farkı`,
          sourceKind: "stock_movement",
          sourceId: count.id,
          lines: journalLines,
          userId: input.userId,
        });
        journalNo = entry.documentNo;
      }

      await tx.stockCount.update({
        where: { id: count.id },
        data: { status: "posted", postedAt: new Date(), postedBy: input.userId },
      });

      const s = summarize(lines);
      return {
        documentNo: input.documentNo,
        adjustedLines: diffs.length,
        netValueDifference: s.netValueDifference,
        journalNo,
      };
    });
  }

  async cancel(documentNo: string): Promise<void> {
    const count = await this.#db.stockCount.findUnique({ where: { documentNo } });
    if (!count) throw new StockCountError(`Sayım bulunamadı: ${documentNo}`);
    if (count.status === "posted") {
      throw new StockCountError("Kaydedilmiş sayım iptal edilemez.");
    }
    await this.#db.stockCount.update({ where: { id: count.id }, data: { status: "cancelled" } });
  }
}

function toCountLines(
  rows: readonly {
    lineNo: number;
    itemId: string;
    batchId: string | null;
    systemQty: unknown;
    countedQty: unknown;
    unitCost: unknown;
  }[],
): CountLine[] {
  return rows.map((l) => ({
    lineNo: l.lineNo,
    itemCode: l.itemId,
    batchId: l.batchId,
    systemQty: Number(l.systemQty),
    countedQty: l.countedQty === null ? null : Number(l.countedQty),
    unitCost: l.unitCost === null ? null : Number(l.unitCost),
  }));
}

function toView(row: {
  documentNo: string;
  locationId: string;
  countDate: Date;
  status: string;
  blind: boolean;
  lines: { lineNo: number; itemId: string; batchId: string | null; systemQty: unknown; countedQty: unknown }[];
}): CountView {
  return {
    documentNo: row.documentNo,
    locationId: row.locationId,
    countDate: row.countDate.toISOString().slice(0, 10),
    status: row.status as CountStatus,
    blind: row.blind,
    lines: row.lines.map((l) => ({
      lineNo: l.lineNo,
      itemCode: l.itemId,
      batchId: l.batchId,
      // KÖR SAYIMDA SİSTEM MİKTARI GİZLENİR. Gösterilseydi sayan kişi onu
      // kopyalar ve sayım hiçbir şey bulmazdı.
      systemQty: row.blind && row.status !== "posted" ? null : Number(l.systemQty),
      countedQty: l.countedQty === null ? null : Number(l.countedQty),
    })),
  };
}
