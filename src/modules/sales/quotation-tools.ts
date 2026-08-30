/**
 * Teklif ve fiyat koşulu tool'ları.
 *
 * TEKLİF VERMEK L1'DİR: bağlayıcı bir öneridir ama geri alınabilir.
 * SİPARİŞE DÖNÜŞTÜRMEK L2'dir: taahhüt doğar, termin ve ceza işlemeye
 * başlar. TEKLİF SEÇMEK (award) L2'dir ve en ucuz seçilmediyse gerekçe
 * ister.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { QuotationRepository } from "../../db/quotation-repository.js";
import { CONDITION_KINDS } from "./pricing-conditions.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });
const money = (n: number, c = "TL") => `${TR.format(n)} ${c === "TRY" ? "TL" : c}`;

export function quotationTools(repo: QuotationRepository) {
  const price = defineTool({
    name: "get_price",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Bir müşteriye bir malzemenin fiyatını hesaplar: liste fiyatı, müşteriye " +
        "özel anlaşma, miktar kademesi ve kampanya iskontoları dahil. FİYATIN " +
        "HANGİ KOŞULDAN GELDİĞİ de döner — 'bu fiyat nereden çıktı' sorusunun " +
        "cevabı budur. Fiyat bulunamazsa UYDURULMAZ.",
      en: "Computes the price for a customer/item using pricing conditions.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      partnerId: z.string().min(1).describe("Müşteri kimliği."),
      quantity: z.number().positive().describe("Miktar — kademeli fiyat için gerekli."),
      currency: z.string().min(3).max(3).describe("Para birimi."),
    }),
    requires: ["sales:price.read"],
    async execute(input, ctx) {
      const r = await repo.price({
        itemCode: input.itemCode,
        partnerId: input.partnerId,
        quantity: input.quantity,
        currency: input.currency.toUpperCase(),
        on: ctx.now(),
      });
      return {
        ok: true as const,
        data: {
          itemCode: input.itemCode,
          unitPrice: r.unitPrice,
          discountPercent: r.discountPercent,
          discountAmount: r.discountAmount,
          surcharge: r.surcharge,
          appliedConditions: r.appliedConditions,
          netUnitPrice:
            r.unitPrice === null
              ? null
              : Math.round(r.unitPrice * (1 - r.discountPercent / 100) * 100) / 100,
        },
        sources: [
          {
            system: "Fiyat koşulları",
            kind: "module" as const,
            recordCount: r.appliedConditions.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: r.caveat ? [{ severity: "warning" as const, message: r.caveat }] : [],
        confidence: r.unitPrice === null ? 40 : 94,
      };
    },
  });

  const setCondition = defineTool({
    name: "set_price_condition",
    module: "sales",
    authority: 2,
    description: {
      tr:
        "Fiyat veya iskonto koşulu tanımlar. EN ÖZGÜL KOŞUL KAZANIR: müşteriye " +
        "özel bir fiyat, genel liste fiyatını ezer. Müşteri veya malzeme boş " +
        "bırakılırsa koşul herkes/her şey için geçerli olur. Miktar kademesi " +
        "için `minQuantity` kullanılır.",
      en: "Defines a price or discount condition. The most specific condition wins.",
    },
    input: z.strictObject({
      kind: z.enum(CONDITION_KINDS).describe("fiyat | iskonto_yuzde | iskonto_tutar | ek_ucret"),
      partnerId: z.string().nullable().describe("Müşteriye özelse kimliği. Herkes için null."),
      itemCode: z.string().max(64).nullable().describe("Malzemeye özelse kodu. Hepsi için null."),
      minQuantity: z.number().nonnegative().describe("Bu miktardan itibaren geçerli. Kademe yoksa 0."),
      currency: z.string().min(3).max(3).describe("Para birimi."),
      value: z.number().nonnegative().describe("Fiyat ya da iskonto değeri."),
      validFrom: z.string().describe("Geçerlilik başlangıcı (ISO 8601)."),
      validTo: z.string().nullable().describe("Geçerlilik bitişi (ISO 8601). Süresizse null."),
    }),
    requires: ["sales:price.write"],
    async execute(input, _ctx) {
      const r = await repo.saveCondition({
        kind: input.kind,
        partnerId: input.partnerId,
        itemCode: input.itemCode,
        minQuantity: input.minQuantity,
        currency: input.currency.toUpperCase(),
        value: input.value,
        validFrom: new Date(input.validFrom),
        validTo: input.validTo ? new Date(input.validTo) : null,
      });
      return {
        ok: true as const,
        data: { id: r.id, kind: input.kind, value: input.value },
        sources: [
          {
            system: "Fiyat koşulları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `Koşul tanımlandı. ${input.partnerId ? "Müşteriye özel" : "Tüm müşteriler"}, ` +
              `${input.itemCode ? input.itemCode : "tüm malzemeler"}` +
              (input.minQuantity > 0 ? `, ${input.minQuantity}+ miktar` : "") + ".",
          },
        ],
        confidence: 97,
      };
    },
  });

  const createQuote = defineTool({
    name: "create_sales_quotation",
    module: "sales",
    authority: 1,
    description: {
      tr:
        "Satış teklifi hazırlar. Fiyat verilmezse FİYAT KOŞULLARINDAN hesaplanır. " +
        "Teklif bir taahhüt değil öneridir ama geçerlilik süresi biter ve o süre " +
        "içinde kabul edilirse bağlayıcıdır — bu yüzden FİYATSIZ TEKLİF VERİLMEZ.",
      en: "Creates a sales quotation, pricing lines from conditions when not given.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Müşteri kimliği."),
      quotedAt: z.string().describe("Teklif tarihi (ISO 8601)."),
      validUntil: z.string().describe("Geçerlilik son günü (ISO 8601)."),
      currency: z.string().min(3).max(3).describe("Para birimi."),
      note: z.string().max(500).nullable().describe("Teklif notu. Yoksa null."),
      lines: z
        .array(
          z.strictObject({
            itemCode: z.string().min(1).max(64),
            quantity: z.number().positive(),
            uom: z.string().min(1).max(16),
            unitPrice: z
              .number()
              .positive()
              .nullable()
              .describe("Elle fiyat. null ise koşullardan hesaplanır."),
            vatRate: z.number().int().describe("KDV oranı: 0, 1, 10 veya 20."),
          }),
        )
        .min(1),
    }),
    requires: ["sales:quotation.write"],
    async execute(input, ctx) {
      const r = await repo.createQuotation({
        partnerId: input.partnerId,
        quotedAt: new Date(input.quotedAt),
        validUntil: new Date(input.validUntil),
        currency: input.currency.toUpperCase(),
        userId: ctx.principal.userId,
        note: input.note,
        lines: input.lines,
      });
      return {
        ok: true as const,
        data: {
          documentNo: r.documentNo,
          totalAmount: r.totalAmount,
          totalLabel: money(r.totalAmount, input.currency),
        },
        sources: [
          {
            system: "Satış teklifleri",
            kind: "module" as const,
            recordCount: input.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...r.caveats.map((c) => ({ severity: "warning" as const, message: c })),
          {
            severity: "info" as const,
            message:
              `${r.documentNo} hazırlandı (${money(r.totalAmount, input.currency)}), ` +
              `${input.validUntil} tarihine kadar geçerli.`,
          },
        ],
        confidence: r.caveats.length > 0 ? 80 : 96,
      };
    },
  });

  const getQuote = defineTool({
    name: "get_sales_quotation",
    module: "sales",
    authority: 0,
    description: {
      tr: "Satış teklifinin kalemlerini, tutarını, durumunu ve geçerlilik süresini döndürür.",
      en: "Returns a sales quotation with its lines and status.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Teklif numarası."),
    }),
    requires: ["sales:quotation.read"],
    async execute(input, ctx) {
      const q = await repo.quotationByNo(input.documentNo);
      const expired = q !== null && new Date(q.validUntil) < ctx.now() && q.status !== "ordered";
      return {
        ok: true as const,
        data: q,
        sources: [
          {
            system: "Satış teklifleri",
            kind: "module" as const,
            recordCount: q?.lines.length ?? 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: !q
          ? [{ severity: "warning" as const, message: `"${input.documentNo}" teklifi bulunamadı.` }]
          : expired
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `Bu teklifin geçerliliği ${q.validUntil} tarihinde doldu; ` +
                    `siparişe dönüştürülemez, yenilenmelidir.`,
                },
              ]
            : [],
        confidence: q ? 96 : 90,
      };
    },
  });

  const convert = defineTool({
    name: "convert_quotation_to_order",
    module: "sales",
    authority: 2,
    description: {
      tr:
        "Kabul edilen teklifi satış siparişine dönüştürür. TEKLİFTEKİ FİYAT AYNEN " +
        "GEÇER — yeniden hesaplansaydı müşteriye verilen sözle fatura arasında fark " +
        "doğardı. SÜRESİ GEÇMİŞ TEKLİF DÖNÜŞTÜRÜLEMEZ.",
      en: "Converts an accepted quotation into a sales order, freezing the quoted price.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Teklif numarası."),
      orderNo: z.string().min(1).max(64).describe("Açılacak sipariş numarası."),
      committedDate: z.string().describe("Müşteriye verilen teslim taahhüdü (ISO 8601)."),
    }),
    requires: ["sales:order.write"],
    async execute(input, ctx) {
      const r = await repo.convertToOrder({
        documentNo: input.documentNo,
        orderNo: input.orderNo,
        committedDate: new Date(input.committedDate),
        on: ctx.now(),
      });
      return {
        ok: true as const,
        data: { quotationNo: input.documentNo, ...r },
        sources: [
          {
            system: "Satış siparişleri",
            kind: "module" as const,
            recordCount: r.lines,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${r.orderNo} açıldı (${r.lines} kalem). Termin ${input.committedDate}; ` +
              `bu tarihten sonrası için gecikme cezası işlemeye başlar.`,
          },
        ],
        confidence: 97,
      };
    },
  });

  const decide = defineTool({
    name: "set_quotation_status",
    module: "sales",
    authority: 1,
    description: {
      tr:
        "Teklifin durumunu günceller: gönderildi, kabul, ret veya süresi doldu. " +
        "RET SEBEBİ ZORUNLUDUR — dönüşüm oranını iyileştiren tek veri budur; " +
        "sebepsiz reddedilen teklifler bir sonrakini de kaybettirir.",
      en: "Updates a quotation's status. A rejection requires a reason.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Teklif numarası."),
      status: z.enum(["sent", "accepted", "rejected", "expired"]).describe("Yeni durum."),
      reason: z.string().max(300).nullable().describe("Ret sebebi. Ret dışında null."),
    }),
    requires: ["sales:quotation.write"],
    async execute(input, _ctx) {
      await repo.setQuotationStatus(input.documentNo, input.status, input.reason);
      return {
        ok: true as const,
        data: { documentNo: input.documentNo, status: input.status },
        sources: [
          {
            system: "Satış teklifleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 97,
      };
    },
  });

  const conversion = defineTool({
    name: "get_quotation_conversion",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Teklif dönüşüm oranı: verilen teklif sayısı, siparişe dönen, reddedilen ve " +
        "EN SIK RET SEBEPLERİ. Bir satış organizasyonunun en temel ölçüsüdür. " +
        "'Tekliflerimizin kaçı siparişe dönüyor' sorusunda kullan.",
      en: "Quotation conversion rate with top rejection reasons.",
    },
    input: z.strictObject({
      from: z.string().describe("Başlangıç (ISO 8601)."),
      to: z.string().describe("Bitiş (ISO 8601)."),
    }),
    requires: ["sales:quotation.read"],
    async execute(input, _ctx) {
      const r = await repo.conversionRate(new Date(input.from), new Date(input.to));
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Satış teklifleri",
            kind: "module" as const,
            recordCount: r.total,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          r.total === 0
            ? [{ severity: "info" as const, message: "Bu aralıkta teklif kaydı yok." }]
            : r.topRejectionReasons.length > 0
              ? [
                  {
                    severity: "info" as const,
                    message:
                      `En sık ret sebebi: "${r.topRejectionReasons[0]!.reason}" ` +
                      `(${r.topRejectionReasons[0]!.count} teklif).`,
                  },
                ]
              : [],
        confidence: 94,
      };
    },
  });

  const createRfq = defineTool({
    name: "create_purchase_rfq",
    module: "documents",
    authority: 1,
    description: {
      tr:
        "Satın alma teklif talebi (RFQ) açar. TEK TEKLİFLE SİPARİŞ VERMEK BİR KARAR " +
        "DEĞİL BİR ALIŞKANLIKTIR; en az iki teklif toplandığında fiyat farkı görünür " +
        "ve 'neden bu tedarikçi' sorusunun kayıtlı cevabı olur.",
      en: "Opens a purchase RFQ to collect supplier quotes.",
    },
    input: z.strictObject({
      requestedAt: z.string().describe("Talep tarihi (ISO 8601)."),
      dueDate: z.string().describe("Tekliflerin son verilme tarihi (ISO 8601)."),
      requisitionNo: z.string().max(64).nullable().describe("Hangi talepten doğdu. Yoksa null."),
    }),
    requires: ["documents:po.draft"],
    async execute(input, ctx) {
      const r = await repo.createRfq({
        requestedAt: new Date(input.requestedAt),
        dueDate: new Date(input.dueDate),
        requisitionNo: input.requisitionNo,
        userId: ctx.principal.userId,
      });
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Teklif talepleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message: `${r.documentNo} açıldı. En az iki teklif toplanmadan seçim yapmayın.`,
          },
        ],
        confidence: 97,
      };
    },
  });

  const recordQuote = defineTool({
    name: "record_supplier_quote",
    module: "documents",
    authority: 1,
    description: {
      tr:
        "Bir tedarikçiden gelen teklifi kaydeder: tutar, para birimi ve TESLİM SÜRESİ. " +
        "Teslim süresi önemlidir — 5 gün geç gelen %3 ucuz teklif, üretimi " +
        "durduracaksa pahalıdır.",
      en: "Records a supplier quote against an RFQ.",
    },
    input: z.strictObject({
      rfqNo: z.string().min(1).max(64).describe("Teklif talebi numarası."),
      partnerId: z.string().min(1).describe("Tedarikçi kimliği."),
      totalAmount: z.number().positive().describe("Teklif tutarı."),
      currency: z.string().min(3).max(3).describe("Para birimi."),
      leadTimeDays: z.number().int().nonnegative().nullable().describe("Teslim süresi (gün)."),
      note: z.string().max(300).nullable().describe("Not. Yoksa null."),
      receivedAt: z.string().describe("Teklifin alındığı tarih (ISO 8601)."),
    }),
    requires: ["documents:po.draft"],
    async execute(input, _ctx) {
      await repo.recordQuote({
        rfqNo: input.rfqNo,
        partnerId: input.partnerId,
        totalAmount: input.totalAmount,
        currency: input.currency.toUpperCase(),
        leadTimeDays: input.leadTimeDays,
        note: input.note,
        receivedAt: new Date(input.receivedAt),
      });
      return {
        ok: true as const,
        data: { rfqNo: input.rfqNo, partnerId: input.partnerId, totalAmount: input.totalAmount },
        sources: [
          {
            system: "Tedarikçi teklifleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 97,
      };
    },
  });

  const compare = defineTool({
    name: "compare_supplier_quotes",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Bir teklif talebine gelen teklifleri karşılaştırır: en ucuz, en hızlı ve " +
        "aradaki fark. TEK TEKLİF KARŞILAŞTIRMA DEĞİLDİR ve bu söylenir.",
      en: "Compares supplier quotes for an RFQ: cheapest, fastest, spread.",
    },
    input: z.strictObject({
      rfqNo: z.string().min(1).max(64).describe("Teklif talebi numarası."),
    }),
    requires: ["documents:po.read"],
    async execute(input, _ctx) {
      const r = await repo.compareQuotes(input.rfqNo);
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Tedarikçi teklifleri",
            kind: "module" as const,
            recordCount: r.quotes.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(!r.comparable
            ? [
                {
                  severity: "warning" as const,
                  message:
                    r.quotes.length === 0
                      ? "Bu talebe hiç teklif gelmemiş."
                      : "Tek teklif var; karşılaştırma yapılamaz. Tek teklifle sipariş " +
                        "vermek bir karar değil, bir alışkanlıktır.",
                },
              ]
            : []),
          ...(r.comparable && r.cheapest && r.fastest && r.cheapest.partnerId !== r.fastest.partnerId
            ? [
                {
                  severity: "info" as const,
                  message:
                    `En ucuz ${r.cheapest.partnerId} (${money(r.cheapest.totalAmount)}), ` +
                    `en hızlı ${r.fastest.partnerId} (${r.fastest.leadTimeDays} gün). ` +
                    `Aradaki fark ${money(r.spread ?? 0)}.`,
                },
              ]
            : []),
        ],
        confidence: 95,
      };
    },
  });

  const award = defineTool({
    name: "award_purchase_rfq",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "Teklif talebinde kazanan tedarikçiyi seçer. EN UCUZ SEÇİLMEDİYSE GEREKÇE " +
        "ZORUNLUDUR — gerekçesiz tercih, denetimde açıklanamayan bir karardır ve " +
        "satın almadaki en yaygın suistimal alanıdır.",
      en: "Awards an RFQ to a supplier. A reason is required if not the cheapest.",
    },
    input: z.strictObject({
      rfqNo: z.string().min(1).max(64).describe("Teklif talebi numarası."),
      partnerId: z.string().min(1).describe("Seçilen tedarikçi."),
      reason: z
        .string()
        .max(300)
        .nullable()
        .describe("En ucuz değilse gerekçe. En ucuzsa null olabilir."),
    }),
    requires: ["approval:procurement.approve"],
    async execute(input, _ctx) {
      const r = await repo.award({
        rfqNo: input.rfqNo,
        partnerId: input.partnerId,
        reason: input.reason,
      });
      return {
        ok: true as const,
        data: { rfqNo: input.rfqNo, ...r },
        sources: [
          {
            system: "Teklif talepleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: r.wasCheapest ? ("info" as const) : ("warning" as const),
            message: r.wasCheapest
              ? `${r.awarded} seçildi (en düşük teklif).`
              : `${r.awarded} seçildi — EN UCUZ DEĞİL. Gerekçe kayda geçti: ${input.reason}`,
          },
        ],
        confidence: 97,
      };
    },
  });

  return [
    price,
    setCondition,
    createQuote,
    getQuote,
    convert,
    decide,
    conversion,
    createRfq,
    recordQuote,
    compare,
    award,
  ] as const;
}
