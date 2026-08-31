/**
 * Kredi limiti ve teslim tarihi tool'ları.
 *
 * ÜÇ TOOL:
 *   get_credit_exposure  → bir carinin toplam riski, üç parçasıyla
 *   set_credit_limit     → limit ve blok (L2)
 *   check_availability   → en erken teslim tarihi
 *
 * `check_credit` AYRI BİR TOOL DEĞİL: risk sorgusu zaten kararı
 * veriyor ve istenen tutar isteğe bağlı. İki ayrı tool olsaydı biri
 * "risk" diğeri "karar" derdi ve ikisi zamanla farklı sayı üretirdi.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { buildExposure, checkCredit } from "./credit.js";
import { checkOrderAvailability } from "./availability.js";
import type { CreditRepository } from "../../db/credit-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

export function creditTools(repo: CreditRepository) {
  const exposure = defineTool({
    name: "get_credit_exposure",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Bir müşterinin toplam kredi riskini ve limitini verir: vadesi geçmiş " +
        "alacak, vadesi gelmemiş açık fatura ve SEVK EDİLMEMİŞ AÇIK SİPARİŞ. " +
        "Yeni bir sipariş tutarı verilirse o siparişin açılıp açılamayacağına " +
        "da karar verir. 'Bu müşteriye satış yapabilir miyiz', 'riski ne kadar', " +
        "'limiti doldu mu' sorularında kullan. Açık sipariş de risktir: yalnızca " +
        "faturaya bakan bir kontrol, aynı müşteriye arka arkaya sipariş açtırır.",
      en: "Customer credit exposure and limit check, including unshipped orders.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Cari kimliği."),
      asOf: z.string().describe("Hangi tarihe göre (ISO 8601)."),
      requestedAmount: z
        .number()
        .min(0)
        .nullable()
        .describe("Açılmak istenen yeni sipariş tutarı; yalnızca risk sorulmuşsa null."),
    }),
    requires: ["sales:order.read"],
    async execute(input) {
      const asOf = new Date(input.asOf);
      if (Number.isNaN(asOf.getTime())) {
        throw new BusinessRuleError(`"${input.asOf}" geçerli bir tarih değil.`, "invalid_date");
      }
      const p = await repo.exposureFor(input.partnerId, asOf);
      if (!p) {
        throw new BusinessRuleError(
          `${input.partnerId} kimlikli cari bulunamadı.`,
          "partner_not_found",
        );
      }

      const risk = buildExposure(p);
      const karar = checkCredit(risk, input.requestedAmount ?? 0);

      const riskler: { severity: "warning" | "info" | "critical"; message: string }[] = [];
      if (karar.decision === "block") {
        riskler.push({ severity: "critical", message: karar.reason });
      } else if (karar.decision === "warn") {
        riskler.push({ severity: "warning", message: karar.reason });
      }
      if (risk.parts.overdue > 0) {
        riskler.push({
          severity: "warning",
          message:
            `Riskin ${TR.format(risk.parts.overdue)} ${risk.currency} kadarı VADESİ ` +
            `GEÇMİŞ alacak. Yeni satıştan önce tahsilat konuşulmalı.`,
        });
      }
      if (risk.parts.openOrders > 0 && input.requestedAmount === null) {
        riskler.push({
          severity: "info",
          message:
            `Riskin ${TR.format(risk.parts.openOrders)} ${risk.currency} kadarı henüz ` +
            `SEVK EDİLMEMİŞ sipariş. Fatura kesilmedi ama taahhüt verildi.`,
        });
      }

      return {
        ok: true as const,
        data: {
          ...risk,
          decision: input.requestedAmount === null ? null : karar.decision,
          requestedAmount: input.requestedAmount,
          projectedTotal: input.requestedAmount === null ? null : karar.projectedTotal,
          reason: input.requestedAmount === null ? null : karar.reason,
        },
        sources: [kaynak("Satış faturaları ve siparişleri", 1)],
        risks: riskler,
        confidence: risk.limit === null ? 70 : 95,
      };
    },
  });

  const setLimit = defineTool({
    name: "set_credit_limit",
    module: "sales",
    authority: 2,
    description: {
      tr:
        "Bir müşteriye kredi limiti tanımlar ya da ticari blok koyar/kaldırır. " +
        "Limit null verilirse 'belirlenmemiş' olur — bu SINIRSIZ demek değildir, " +
        "kontrol o zaman uyarır ve kararı insana bırakır. Blok konulacaksa SEBEP " +
        "zorunlu: sebepsiz bir blok, aylar sonra kimsenin kaldırmaya cesaret " +
        "edemediği bir bloktur. Limit değişikliği iz bırakır.",
      en: "Sets a customer credit limit or commercial block.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Cari kimliği."),
      limit: z.number().min(0).nullable().describe("Kredi limiti; belirlenmemiş bırakmak için null."),
      currency: z.string().length(3).describe("Limitin para birimi. Genelde TRY."),
      blocked: z.boolean().describe("Ticari blok konsun mu?"),
      blockReason: z.string().max(300).nullable().describe("Blok sebebi. blocked=true ise ZORUNLU."),
    }),
    requires: ["sales:order.write"],
    async execute(input, ctx) {
      if (input.blocked && (input.blockReason === null || input.blockReason.trim() === "")) {
        throw new BusinessRuleError(
          "Blok konulacaksa sebebi yazılmalı. Sebepsiz bir blok, aylar sonra " +
            "kimsenin kaldırmaya cesaret edemediği bir bloktur.",
          "block_reason_required",
        );
      }
      const res = await repo.setLimit({
        partnerId: input.partnerId,
        limit: input.limit,
        currency: input.currency.toUpperCase(),
        blocked: input.blocked,
        blockReason: input.blocked ? input.blockReason : null,
        userId: ctx.principal.userId,
      });

      return {
        ok: true as const,
        data: { ...res, limit: input.limit, blocked: input.blocked },
        sources: [kaynak("Cari kartları", 1)],
        risks: [
          {
            severity: input.blocked ? ("warning" as const) : ("info" as const),
            message: input.blocked
              ? `${res.partnerName} ticari olarak BLOKELİ: ${input.blockReason}. ` +
                `Bu cariye yeni sipariş açılamaz.`
              : input.limit === null
                ? `${res.partnerName} için limit KALDIRILDI (belirlenmemiş). Kontrol ` +
                  `artık uyarır ama engellemez.`
                : `${res.partnerName} limiti ${
                    res.previousLimit === null ? "belirsiz" : TR.format(res.previousLimit)
                  } → ${TR.format(input.limit)} ${input.currency.toUpperCase()}.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const availability = defineTool({
    name: "check_availability",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Bir siparişin en erken ne zaman sevk edilebileceğini hesaplar: serbest " +
        "stok, yoldaki mal ve temin süresine bakar. 'Ne zaman gönderebiliriz', " +
        "'teslim tarihi verebilir miyiz', 'stokta var mı' sorularında kullan. " +
        "ELDEKİ STOK SERBEST STOK DEĞİLDİR: başka siparişlere ayrılmış miktar " +
        "düşülür. Temin süresi bilinmiyorsa TARİH VERİLMEZ — 'tahminen üç hafta' " +
        "demek bir taahhüttür ve sözleşme cezasına bağlanır.",
      en: "Available-to-promise: earliest possible delivery date for order lines.",
    },
    input: z.strictObject({
      asOf: z.string().describe("Hangi tarihe göre (ISO 8601)."),
      lines: z
        .array(
          z.strictObject({
            itemCode: z.string().trim().min(1).max(60).describe("Malzeme kodu."),
            quantity: z.number().positive().describe("İstenen miktar."),
          }),
        )
        .min(1)
        .max(50)
        .describe("Sipariş kalemleri."),
    }),
    requires: ["sales:order.read"],
    async execute(input) {
      const asOf = new Date(input.asOf);
      if (Number.isNaN(asOf.getTime())) {
        throw new BusinessRuleError(`"${input.asOf}" geçerli bir tarih değil.`, "invalid_date");
      }

      const pozisyonlar = await Promise.all(
        input.lines.map(async (l) => ({ line: l, stock: await repo.stockPosition(l.itemCode) })),
      );

      const bulunmayan = pozisyonlar.filter((p) => p.stock === null).map((p) => p.line.itemCode);
      if (bulunmayan.length > 0) {
        throw new BusinessRuleError(
          `Malzeme kartı bulunamadı: ${bulunmayan.join(", ")}. Kartı olmayan bir ` +
            `malzeme için teslim tarihi hesaplanamaz.`,
          "item_not_found",
        );
      }

      const sonuc = checkOrderAvailability(
        asOf,
        pozisyonlar.map((p) => ({
          itemCode: p.line.itemCode,
          quantity: p.line.quantity,
          stock: p.stock!,
        })),
      );

      const riskler: { severity: "warning" | "info" | "critical"; message: string }[] = [];
      if (sonuc.earliestDate === null) {
        riskler.push({
          severity: "critical",
          message:
            `TESLİM TARİHİ SÖYLENEMEZ. Şu kalemlerde temin süresi yazılı değil ve ` +
            `stok yetmiyor: ${sonuc.unknownItems.join(", ")}. Malzeme kartına temin ` +
            `süresi girilirse tarih hesaplanır — tahmin yürütmek, sözleşme cezasına ` +
            `bağlanan bir taahhüt üretir.`,
        });
      } else if (sonuc.basis === "lead-time") {
        riskler.push({
          severity: "warning",
          message:
            `${sonuc.earliestDate} tarihi TEMİN SÜRESİNE dayanıyor ve satın alma ` +
            `siparişinin bugün verildiğini varsayar. Sipariş açılmazsa bu tarih tutmaz.`,
        });
      } else if (sonuc.basis === "inbound") {
        riskler.push({
          severity: "info",
          message:
            `${sonuc.earliestDate} tarihi tedarikçinin TERMİN TAAHHÜDÜNE dayanıyor; ` +
            `darboğaz kalem ${sonuc.bottleneck}.`,
        });
      }

      return {
        ok: true as const,
        data: sonuc,
        sources: [kaynak("Stok ve siparişler", input.lines.length)],
        risks: riskler,
        confidence:
          sonuc.basis === "stock" ? 96 : sonuc.basis === "inbound" ? 80 : sonuc.basis === "lead-time" ? 65 : 30,
      };
    },
  });

  return [exposure, setLimit, availability] as const;
}
