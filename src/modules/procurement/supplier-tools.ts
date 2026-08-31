/**
 * Çerçeve sözleşme ve tedarikçi karnesi tool'ları.
 *
 * BEŞ TOOL:
 *   create_purchase_contract  → yıllık anlaşma (L2)
 *   list_purchase_contracts   → sözleşmeler ve tavan kullanımı
 *   release_from_contract     → sözleşmeden sipariş çek (L2)
 *   get_supplier_scorecard    → termin/miktar/fiyat performansı
 *   get_price_history         → aynı malın tedarikçi bazında fiyatı
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { buildScorecard, assertWithinCeiling, ContractError } from "./scorecard.js";
import type { SupplierRepository } from "../../db/supplier-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

function tarih(s: string, alan: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BusinessRuleError(`${alan}: "${s}" geçerli bir tarih değil.`, "invalid_date");
  }
  return d;
}

export function supplierTools(repo: SupplierRepository) {
  const createContract = defineTool({
    name: "create_purchase_contract",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "Çerçeve (yıllık) satın alma sözleşmesi açar: tedarikçi, malzeme, geçerlilik " +
        "dönemi, birim fiyat ve tavan (tutar ve/veya miktar). Sözleşmeden sipariş " +
        "çekildikçe tavan tüketilir. Tavan verilmezse sözleşme yalnızca fiyatı " +
        "sabitler. 'Yıllık anlaşma', 'çerçeve sözleşme' isteklerinde kullan.",
      en: "Creates a blanket purchase contract with optional ceilings.",
    },
    input: z.strictObject({
      documentNo: z.string().trim().min(1).max(64).describe("Sözleşme numarası, benzersiz."),
      partnerId: z.string().min(1).describe("Tedarikçi cari kimliği."),
      itemCode: z.string().trim().max(60).nullable().describe("Tek malzeme sözleşmesiyse kodu; genel sözleşmede null."),
      description: z.string().trim().min(3).max(400).describe("Sözleşme konusu."),
      validFrom: z.string().describe("Geçerlilik başlangıcı (ISO 8601)."),
      validTo: z.string().describe("Geçerlilik bitişi (ISO 8601)."),
      ceilingAmount: z.number().positive().nullable().describe("Tutar tavanı; yoksa null."),
      ceilingQuantity: z.number().positive().nullable().describe("Miktar tavanı; yoksa null."),
      unitPrice: z.number().min(0).nullable().describe("Sabitlenen birim fiyat; yoksa null."),
      currency: z.string().length(3).describe("Para birimi."),
    }),
    requires: ["documents:requisition.write"],
    async execute(input, ctx) {
      const from = tarih(input.validFrom, "validFrom");
      const to = tarih(input.validTo, "validTo");
      if (to < from) {
        throw new BusinessRuleError(
          "Bitiş tarihi başlangıçtan önce olamaz.",
          "invalid_period",
        );
      }
      const res = await repo.createContract({
        documentNo: input.documentNo,
        partnerId: input.partnerId,
        itemId: input.itemCode,
        description: input.description,
        validFrom: from,
        validTo: to,
        ceilingAmount: input.ceilingAmount,
        ceilingQuantity: input.ceilingQuantity,
        unitPrice: input.unitPrice,
        currency: input.currency.toUpperCase(),
        userId: ctx.principal.userId,
      });
      return {
        ok: true as const,
        data: { ...res, validTo: input.validTo, ceilingAmount: input.ceilingAmount },
        sources: [kaynak("Satın alma sözleşmeleri", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.documentNo} sözleşmesi açıldı (${input.validFrom} – ${input.validTo}).` +
              (input.ceilingAmount === null && input.ceilingQuantity === null
                ? " Tavan yok: sözleşme yalnızca fiyatı sabitliyor."
                : ` Tavan: ${
                    input.ceilingAmount !== null
                      ? `${TR.format(input.ceilingAmount)} ${input.currency.toUpperCase()}`
                      : `${input.ceilingQuantity} birim`
                  }.`),
          },
        ],
        confidence: 99,
      };
    },
  });

  const listContracts = defineTool({
    name: "list_purchase_contracts",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Çerçeve sözleşmeleri ve tavan kullanımını listeler: ne kadarı kullanıldı, " +
        "ne kadar kaldı, ne zaman bitiyor. 'Anlaşmalarımız', 'sözleşme durumu', " +
        "'tavan doldu mu' sorularında kullan.",
      en: "Lists blanket purchase contracts with ceiling usage.",
    },
    input: z.strictObject({
      partnerId: z.string().max(64).nullable().describe("Tek tedarikçi için kimlik; hepsi için null."),
      activeOnly: z.boolean().describe("Yalnızca yürürlükteki sözleşmeler mi?"),
    }),
    requires: ["documents:requisition.read"],
    async execute(input, ctx) {
      const rows = await repo.listContracts(input.partnerId, input.activeOnly);
      const bugun = ctx.now();
      const yakinda = rows.filter(
        (c) =>
          c.status === "active" &&
          new Date(c.validTo).getTime() - bugun.getTime() < 60 * 86_400_000,
      );
      const dolmakUzere = rows.filter((c) => c.usedPercent !== null && c.usedPercent >= 90);

      return {
        ok: true as const,
        data: { total: rows.length, contracts: rows },
        sources: [kaynak("Satın alma sözleşmeleri", rows.length)],
        risks: [
          ...(yakinda.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${yakinda.length} sözleşme 60 gün içinde bitiyor: ` +
                    `${yakinda.map((c) => `${c.documentNo} (${c.validTo})`).join(", ")}. ` +
                    `Yenilenmezse fiyat serbest kalır.`,
                },
              ]
            : []),
          ...(dolmakUzere.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${dolmakUzere.length} sözleşmenin tavanı %90'ı geçti; yeni çekiliş ` +
                    `reddedilebilir.`,
                },
              ]
            : []),
        ],
        confidence: 97,
      };
    },
  });

  const release = defineTool({
    name: "release_from_contract",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "Bir çerçeve sözleşmeden sipariş çeker ve tavanı tüketir. TAVAN AŞILAMAZ: " +
        "aşan bir çekiliş yeni bir anlaşma gerektirir. Aynı sipariş bir sözleşmeden " +
        "iki kez çekilemez.",
      en: "Releases a purchase order against a blanket contract, consuming the ceiling.",
    },
    input: z.strictObject({
      contractNo: z.string().trim().min(1).max(64).describe("Sözleşme numarası."),
      poId: z.string().trim().min(1).max(64).describe("Satın alma siparişi kimliği."),
      quantity: z.number().positive().describe("Çekilen miktar."),
      amount: z.number().positive().describe("Çekilen tutar."),
      releasedAt: z.string().describe("Çekiliş tarihi (ISO 8601)."),
    }),
    requires: ["documents:requisition.write"],
    async execute(input, ctx) {
      const durum = await repo.contractUsage(input.contractNo);
      if (!durum) {
        throw new BusinessRuleError(
          `${input.contractNo} numaralı sözleşme bulunamadı.`,
          "contract_not_found",
        );
      }
      if (durum.contract.status !== "active") {
        throw new BusinessRuleError(
          `${input.contractNo} sözleşmesi ${durum.contract.status} durumda; ` +
            `yürürlükte olmayan bir sözleşmeden sipariş çekilemez.`,
          "contract_not_active",
        );
      }

      const at = tarih(input.releasedAt, "releasedAt");
      if (at > new Date(durum.contract.validTo)) {
        throw new BusinessRuleError(
          `Çekiliş tarihi (${input.releasedAt}) sözleşmenin bitişinden ` +
            `(${durum.contract.validTo}) sonra. Süresi dolmuş bir anlaşmanın fiyatı ` +
            `bağlayıcı değildir.`,
          "contract_expired",
        );
      }

      try {
        assertWithinCeiling(durum.usage, input.amount, input.quantity, input.contractNo);
      } catch (e) {
        if (e instanceof ContractError) {
          throw new BusinessRuleError(e.message, "contract_ceiling_exceeded");
        }
        throw e;
      }

      const id = (await repo.contractIdOf(input.contractNo))!;
      await repo.recordRelease({
        contractId: id,
        poId: input.poId,
        quantity: input.quantity,
        amount: input.amount,
        releasedAt: at,
        userId: ctx.principal.userId,
      });

      const yeni = await repo.contractUsage(input.contractNo);
      return {
        ok: true as const,
        data: {
          contractNo: input.contractNo,
          poId: input.poId,
          usage: yeni!.usage,
        },
        sources: [kaynak("Sözleşme çekilişleri", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${input.poId} siparişi ${input.contractNo} sözleşmesinden çekildi. ` +
              (yeni!.usage.remainingAmount !== null
                ? `Kalan tavan: ${TR.format(yeni!.usage.remainingAmount)} ${durum.contract.currency}.`
                : "Tavan tanımlı değil."),
          },
        ],
        confidence: 99,
      };
    },
  });

  const scorecard = defineTool({
    name: "get_supplier_scorecard",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Tedarikçi karnesi: termin performansı (zamanında geldi mi), miktar " +
        "performansı (tam geldi mi) ve fiyat değişimi. MAL KABUL KAYITLARINDAN " +
        "HESAPLANIR, elle girilmez. 'Bu tedarikçi nasıl', 'kim geciktiriyor', " +
        "'tedarikçi performansı' sorularında kullan. Üç teslimattan az veri varsa " +
        "PUAN VERİLMEZ — az veriden çıkan puan yanıltıcıdır.",
      en: "Supplier scorecard computed from goods receipts: on-time, in-full, price drift.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Tedarikçi cari kimliği."),
      sinceMonths: z
        .number()
        .int()
        .min(1)
        .max(60)
        .describe("Kaç aylık geçmişe bakılsın. Genelde 12."),
    }),
    requires: ["documents:requisition.read"],
    async execute(input, ctx) {
      const ad = await repo.partnerName(input.partnerId);
      if (ad === null) {
        throw new BusinessRuleError("Cari bulunamadı.", "partner_not_found");
      }
      const since = new Date(ctx.now().getTime() - input.sinceMonths * 30 * 86_400_000);
      const [teslimatlar, fiyatlar] = await Promise.all([
        repo.deliveryHistory(input.partnerId, since),
        repo.priceChanges(input.partnerId),
      ]);

      const karne = buildScorecard(input.partnerId, ad, teslimatlar, fiyatlar);

      return {
        ok: true as const,
        data: karne,
        sources: [kaynak("Mal kabul kayıtları", teslimatlar.length)],
        risks: [
          {
            severity:
              karne.score === null
                ? ("info" as const)
                : karne.score < 65
                  ? ("warning" as const)
                  : ("info" as const),
            message: karne.verdict,
          },
          ...(karne.withoutPromise > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${karne.withoutPromise} teslimatta TERMİN ALINMAMIŞ. Termin ` +
                    `olmadan "geç kaldı" denemez; bu teslimatlar performans ` +
                    `hesabının dışında kaldı.`,
                },
              ]
            : []),
        ],
        confidence: karne.score === null ? 45 : 90,
      };
    },
  });

  const priceHistory = defineTool({
    name: "get_price_history",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Bir malzemenin tedarikçi bazında fiyat geçmişi: kimden, ne zaman, kaça " +
        "alındı. 'Bu malı geçen sefer kaça almıştık', 'fiyat artmış mı', 'hangi " +
        "tedarikçi ucuz' sorularında kullan.",
      en: "Price history for an item across suppliers.",
    },
    input: z.strictObject({
      itemCode: z.string().trim().min(1).max(60).describe("Malzeme kodu."),
    }),
    requires: ["documents:requisition.read"],
    async execute(input) {
      const rows = await repo.priceHistory(input.itemCode);
      const fiyatlar = rows.map((r) => r.unitPrice);
      const enDusuk = fiyatlar.length > 0 ? Math.min(...fiyatlar) : null;
      const enYuksek = fiyatlar.length > 0 ? Math.max(...fiyatlar) : null;

      return {
        ok: true as const,
        data: {
          itemCode: input.itemCode,
          total: rows.length,
          lowest: enDusuk,
          highest: enYuksek,
          history: rows,
        },
        sources: [kaynak("Satın alma siparişleri", rows.length)],
        risks:
          rows.length === 0
            ? [
                {
                  severity: "info" as const,
                  message: "Bu malzeme için satın alma geçmişi yok.",
                },
              ]
            : enDusuk !== null && enYuksek !== null && enDusuk > 0 && enYuksek / enDusuk > 1.3
              ? [
                  {
                    severity: "warning" as const,
                    message:
                      `Fiyat aralığı geniş: en düşük ${TR.format(enDusuk)}, en yüksek ` +
                      `${TR.format(enYuksek)} (%${Math.round((enYuksek / enDusuk - 1) * 100)} fark). ` +
                      `Aynı malı çok farklı fiyatlara alıyorsunuz.`,
                  },
                ]
              : [],
        confidence: 95,
      };
    },
  });

  return [createContract, listContracts, release, scorecard, priceHistory] as const;
}
