/**
 * Kur değerlemesi tool'ları.
 *
 * İKİ ADIM, KASITLI: önce göster, sonra yaz.
 *
 * Değerleme geri alınması pahalı bir işlemdir — kambiyo kârı gelir
 * tablosuna girer, beyannameye yansır. Tek adımda yapılsaydı model
 * "değerle" cümlesini duyar duymaz fiş atardı ve mali müşavir rakamı
 * ancak beyandan sonra görürdü. Önizleme L0'dır ve serbestçe çağrılır;
 * yazma L3'tür ve insan onayı olmadan geçmez.
 *
 * ÖNİZLEME HER ZAMAN KURLARI GÖSTERİR. "Ne kadar kâr çıktı" cevabı tek
 * başına denetlenemez; hangi kurla hesaplandığı görünmeden onaylanan bir
 * rakam, imzalanmadan onaylanmış demektir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import type { RevaluationRepository } from "../../db/revaluation-repository.js";
import type { ValuationRepository } from "../../db/valuation-repository.js";
import { revalue, type RevaluedLine } from "./revaluation.js";
import type { RateQuote } from "./exchange.js";

/** Ayın son günü — değerleme her zaman dönem sonunda yapılır. */
function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

function summarize(l: RevaluedLine) {
  return {
    account: l.accountCode,
    partner: l.partnerName ?? l.partnerId,
    currency: l.currency,
    fxBalance: l.fxBalance,
    bookBalance: l.bookBalance,
    rate: l.rate,
    quotedAt: l.quotedAt,
    currentValue: l.currentValue,
    difference: l.difference,
  };
}

export function revaluationTools(repo: RevaluationRepository, valuation: ValuationRepository) {
  /**
   * Ortak hazırlık: açık bakiyeleri bul, kurlarını topla, değerle.
   *
   * İki tool da aynı hesabı yapar — önizlemenin gösterdiği rakam ile
   * yazılan rakam farklı olsaydı, onay hiçbir şey ifade etmezdi.
   */
  async function prepare(asOf: Date) {
    const balances = await repo.openBalances(asOf);
    const currencies = [...new Set(balances.map((b) => b.currency))].filter((c) => c !== "TRY");

    const quotes: Record<string, RateQuote> = {};
    for (const c of currencies) {
      try {
        quotes[c] = await valuation.rateFor(c, asOf);
      } catch {
        // Kur bulunamadı. Sessizce atlamıyoruz: `revalue` eksik kuru
        // hata olarak bildirecek ve HANGİ para birimi olduğunu söyleyecek.
      }
    }

    return { balances, revaluation: revalue(balances, quotes, asOf) };
  }

  const preview = defineTool({
    name: "preview_fx_revaluation",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Dönem sonu kur değerlemesini HESAPLAR AMA YAZMAZ: hangi cariden ne kadar " +
        "döviz açık, o günün kuruyla TL karşılığı ne, defterdeki tutarla farkı ne. " +
        "'Kur farkı ne kadar çıkar', 'Aralık sonu değerleme' sorularında kullan. " +
        "Kuru olmayan bir para birimi varsa hesap yapılmaz ve hangisi olduğu söylenir.",
      en: "Previews period-end FX revaluation without posting anything.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z.number().int().min(1).max(12).describe("Değerleme yapılacak ayın numarası."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const asOf = endOfMonth(input.year, input.month);
      const already = await repo.existing(asOf);
      const { revaluation: r } = await prepare(asOf);

      return {
        ok: true as const,
        data: {
          asOf: r.asOf,
          alreadyPosted: already !== null,
          lineCount: r.lines.length,
          gain: r.gain,
          loss: r.loss,
          netDifference: r.difference,
          rates: r.rates,
          lines: r.lines.map(summarize),
        },
        sources: [
          {
            system: "Yevmiye defteri + kur tablosu",
            kind: "module" as const,
            recordCount: r.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: already
          ? [
              {
                severity: "warning" as const,
                message:
                  `${r.asOf} tarihi ZATEN DEĞERLENDİ (fark ${already.difference} ₺). ` +
                  `İkinci bir değerleme kur farkını iki kez yazar.`,
              },
            ]
          : [],
        confidence: 95,
      };
    },
  });

  const post = defineTool({
    name: "post_fx_revaluation",
    module: "accounting",
    // L3: gelir tablosuna giren, beyannameye yansıyan bir kayıt yazar.
    // Ters kaydedilebilir ama iz bırakır.
    authority: 3,
    description: {
      tr:
        "Dönem sonu kur değerlemesini YEVMİYEYE YAZAR: dövizli açık bakiyeler o günün " +
        "kuruyla değerlenir, fark 646 Kambiyo Kârları / 656 Kambiyo Zararları'na " +
        "kaydedilir. Önce preview_fx_revaluation ile rakamı gösterin. " +
        "Aynı tarihe ikinci kez yazılamaz.",
      en: "Posts the period-end FX revaluation journal entry.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z.number().int().min(1).max(12).describe("Değerleme yapılacak ayın numarası."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, ctx) {
      const asOf = endOfMonth(input.year, input.month);

      // AYNI TARİHE İKİNCİ DEĞERLEME OLMAZ. Veritabanında da kısıt var
      // ama hata mesajı orada anlaşılmaz olurdu; burada sebebiyle söyleniyor.
      const already = await repo.existing(asOf);
      if (already) {
        throw new BusinessRuleError(
          `${already.asOf} tarihi zaten değerlendi (fark ${already.difference} ₺). ` +
            `İkinci bir değerleme kur farkını iki kez yazar ve kambiyo kârını ` +
            `şişirir. Yeniden değerlemek için önce mevcut fişi ters kaydedin.`,
          "fx_revaluation_exists",
        );
      }

      const { revaluation: r } = await prepare(asOf);
      const written = await repo.post(r, ctx.principal.userId);

      return {
        ok: true as const,
        data: {
          asOf: r.asOf,
          documentNo: written.documentNo,
          gain: r.gain,
          loss: r.loss,
          netDifference: r.difference,
          lineCount: r.lines.length,
          rates: r.rates,
        },
        sources: [
          {
            system: "Yevmiye defteri",
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

  return [preview, post];
}
