/**
 * Değerleme ve kur tool'ları.
 *
 * BU MODÜLÜN TEK BİR DİSİPLİNİ VAR: bilinmeyeni bilinen gibi sunmamak.
 * Her cevap, kaç kalemin değerlenebildiğini ve kaçının değerlenemediğini
 * söyler. "Envanter değeri 12.400.000 TL" cümlesi, 6 kalemin maliyeti
 * bilinmiyorsa eksiktir ve eksikliği söylenmeden verilirse yanlıştır.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { ValuationRepository } from "../../db/valuation-repository.js";
import { holds, redactFields } from "../../kernel/rbac.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

export function valuationTools(repo: ValuationRepository) {
  const itemCost = defineTool({
    name: "get_item_cost",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Bir malzemenin eldeki miktarını, birim maliyetini ve stok değerini döndürür. " +
        "Maliyet BİLİNMİYORSA null döner — sıfır maliyet 'bedava' demektir ve " +
        "kârlılığı %100 gösterir. 'Bu malzeme bize kaça mal oluyor', " +
        "'stokta ne kadar değer var' sorularında kullan.",
      en: "Returns on-hand quantity, unit cost and stock value for one material.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
    }),
    requires: ["inventory:valuation.read"],
    async execute(input, _ctx) {
      const v = await repo.costOf(input.itemCode);
      return {
        ok: true as const,
        data: {
          itemCode: input.itemCode,
          quantityOnHand: v.quantity,
          unitCost: v.unitCost,
          totalValue: v.value,
          valueLabel: v.value === null ? null : `${TR.format(v.value)} TL`,
        },
        sources: [
          {
            system: "Stok değerleme",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: v.caveat
          ? [{ severity: "warning" as const, message: v.caveat }]
          : [],
        confidence: v.caveat ? 60 : 95,
      };
    },
  });

  const inventoryValue = defineTool({
    name: "get_inventory_value",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Toplam envanter değerini döndürür. Maliyeti bilinmeyen kalemler " +
        "TOPLAMA DAHİL EDİLMEZ ve ayrıca sayılır; sıfır maliyetle toplansalardı " +
        "envanter olduğundan düşük çıkar ve bilanço yanlış olurdu.",
      en: "Returns total inventory value; unvalued items are excluded and counted separately.",
    },
    input: z.strictObject({}),
    requires: ["inventory:valuation.read"],
    async execute(_input, _ctx) {
      const v = await repo.inventoryValue();
      return {
        ok: true as const,
        data: {
          totalValue: v.totalValue,
          valueLabel: `${TR.format(v.totalValue)} TL`,
          valuedItems: v.valuedItems,
          unvaluedItems: v.unvaluedItems,
          unvaluedCodes: v.unvaluedCodes,
        },
        sources: [
          {
            system: "Stok değerleme",
            kind: "module" as const,
            recordCount: v.valuedItems + v.unvaluedItems,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          v.unvaluedItems > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${v.unvaluedItems} kalemin maliyeti bilinmiyor ve bu tutara DAHİL DEĞİL ` +
                    `(${v.unvaluedCodes.join(", ")}). Gerçek envanter değeri daha yüksektir.`,
                },
              ]
            : [],
        confidence: v.unvaluedItems > 0 ? 70 : 95,
      };
    },
  });

  const getRate = defineTool({
    name: "get_exchange_rate",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "Bir para biriminin belirtilen tarihteki kurunu döndürür. Hafta sonu ve " +
        "tatilde en son ilan edilen kur kullanılır. KUR YOKSA HATA DÖNER — " +
        "1 varsayılmaz, çünkü 126.000 EUR'yu 126.000 TL sanmak raporun " +
        "tamamını çöpe atar.",
      en: "Returns the exchange rate for a currency on a given date.",
    },
    input: z.strictObject({
      currency: z.string().min(3).max(3).describe("Para birimi kodu: EUR, USD…"),
      on: z.string().describe("Tarih (ISO 8601). Bugün için bugünün tarihi."),
    }),
    requires: ["finance:fx.read"],
    async execute(input, _ctx) {
      const q = await repo.rateFor(input.currency.toUpperCase(), new Date(input.on));
      return {
        ok: true as const,
        data: { currency: q.currency, rate: q.rate, quotedAt: q.quotedAt, source: q.source },
        sources: [
          {
            system: `Döviz kuru (${q.source})`,
            kind: "module" as const,
            recordCount: 1,
            syncedAt: q.quotedAt,
          },
        ],
        risks:
          q.ageDays > 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    `${q.currency} için ${q.quotedAt} tarihli kur kullanıldı ` +
                    `(${q.ageDays} gün önce ilan edilmiş).`,
                },
              ]
            : [],
        confidence: q.ageDays > 2 ? 80 : 96,
      };
    },
  });

  const setRate = defineTool({
    name: "set_exchange_rate",
    module: "finance",
    authority: 1,
    description: {
      tr:
        "Bir para biriminin belirli bir güne ait kurunu kaydeder. Aynı güne " +
        "ikinci kayıt öncekini GÜNCELLER — iki farklı 'resmî kur' tutulamaz.",
      en: "Records the published exchange rate for a currency on a date.",
    },
    input: z.strictObject({
      currency: z.string().min(3).max(3).describe("Para birimi kodu."),
      rate: z.number().positive().describe("1 birim yabancı para kaç TL."),
      quotedAt: z.string().describe("Kurun ilan edildiği gün (ISO 8601)."),
      source: z.string().max(40).describe("Kaynak: TCMB, manuel, entegratör."),
    }),
    requires: ["finance:fx.write"],
    async execute(input, _ctx) {
      await repo.saveRate({
        currency: input.currency.toUpperCase(),
        rate: input.rate,
        quotedAt: new Date(input.quotedAt),
        source: input.source,
      });
      return {
        ok: true as const,
        data: { currency: input.currency.toUpperCase(), rate: input.rate, quotedAt: input.quotedAt },
        sources: [
          {
            system: "Döviz kuru",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 98,
      };
    },
  });

  const goodsReceipt = defineTool({
    name: "post_goods_receipt",
    module: "inventory",
    authority: 1,
    description: {
      tr:
        "Mal kabulü kaydeder: stoğa girer ve HAREKETLİ ORTALAMA MALİYETİ günceller. " +
        "Yabancı para alımda maliyet, işlem tarihindeki kurla TL'ye çevrilir; " +
        "kur yoksa kayıt YAPILMAZ. 'Şu malzemeden 100 adet geldi, birimi 70 TL' " +
        "denince kullan.",
      en: "Posts a goods receipt and updates the moving average cost.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      locationId: z.string().min(1).max(64).describe("Malın girdiği depo."),
      quantity: z.number().positive().describe("Miktar — temel birimde."),
      unitCost: z.number().nonnegative().describe("Birim maliyet, belirtilen para biriminde."),
      currency: z.string().min(3).max(3).describe("Maliyetin para birimi. TL için TRY."),
      receivedAt: z.string().describe("Giriş tarihi (ISO 8601)."),
      batchId: z.string().max(64).nullable().describe("Parti numarası. Yoksa null."),
    }),
    // MAL KABULÜ DEPONUN İŞİDİR AMA ORTALAMA MALİYET MALİ BİR BİLGİDİR.
    // Depo, irsaliyedeki birim fiyatı zaten görür ve girer; ama TÜM
    // alımların ağırlıklı ortalaması ona kapalıdır ve cevaptan maskelenir.
    requires: ["inventory:movement.write"],
    async execute(input, ctx) {
      const canSeeCost = holds(ctx.principal, "inventory:valuation.read");
      const res = await repo.postReceipt({
        itemId: input.itemCode,
        locationId: input.locationId,
        quantity: input.quantity,
        unitCost: input.unitCost,
        currency: input.currency.toUpperCase(),
        at: new Date(input.receivedAt),
        userId: ctx.principal.userId,
        batchId: input.batchId,
        referenceKind: "manual",
      });

      return {
        ok: true as const,
        data: redactFields(
          {
            itemCode: input.itemCode,
            quantityOnHand: res.quantityOnHand,
            newUnitCost: res.unitCost as unknown,
            valueIn: res.value as unknown,
            exchangeRate: res.rate,
          },
          [
            { field: "newUnitCost", requires: "inventory:valuation.read" },
            { field: "valueIn", requires: "inventory:valuation.read" },
          ],
          ctx.principal,
        ),
        sources: [
          {
            system: "Stok değerleme",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          // ORTALAMA ALINAMADIYSA BU HERKESE SÖYLENİR — maliyet rakamı
          // maskelenir ama güvenilmez olduğu bilgisi maskelenmez; aksi
          // hâlde depo, sistemin bilmediği bir şeyi bildiğini sanır.
          ...(res.caveat
            ? [{ severity: "warning" as const, message: res.caveat }]
            : []),
          {
            severity: "info" as const,
            message: canSeeCost
              ? `${input.itemCode}: eldeki miktar ${res.quantityOnHand}, ` +
                `yeni ortalama birim maliyet ${TR.format(res.unitCost)} TL` +
                (res.rate !== null ? ` (${input.currency} kuru ${res.rate}).` : ".")
              : `${input.itemCode}: giriş kaydedildi, eldeki miktar ${res.quantityOnHand}.`,
          },
        ],
        confidence: res.caveat ? 70 : 97,
      };
    },
  });

  return [itemCost, inventoryValue, getRate, setRate, goodsReceipt] as const;
}
