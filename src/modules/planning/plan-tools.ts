/**
 * İşlem planı tool'ları.
 *
 * BEŞ TOOL, TEK AKIŞ:
 *   create_operation_plan → adımları yaz, ONAY BEKLE
 *   get_operation_plan    → planı ve durumunu oku
 *   list_operation_plans  → geçmiş planlar
 *   run_operation_plan    → sırayla koş (L2/L3 — planın kendi yetkisi)
 *   cancel_operation_plan → koşmadan iptal
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * PLANI YAZAN TOOL L0'DIR, KOŞTURAN DEĞİL.
 *
 * Plan yazmak hiçbir şeyi değiştirmez: bir liste üretir. Tehlikeli
 * olan onu koşturmaktır ve onay kapısı orada duruyor. İkisini tek
 * tool'da birleştirmek, "planı göster" demenin de onay istemesine yol
 * açardı — ve kullanıcı görmeden onaylamak zorunda kalırdı.
 *
 * KOŞUM ADIMLARI AYNI RBAC YOLUNDAN GEÇER. Her adım `invokeTool` ile
 * ve KULLANICININ kendi principal'ıyla çağrılıyor; plan bir yan kapı
 * değil. Yetkisi olmayan bir adım, planın içinde de reddedilir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { invokeTool } from "../../kernel/invoke.js";
import {
  assertSteps,
  assertRunnable,
  requiredAuthority,
  planAfterFailure,
  buildReport,
  assertConfirmationMatches,
  PlanError,
  type PlanStep,
  type StepOutcome,
} from "./operation-plan.js";
import type { PlanRepository } from "../../db/plan-repository.js";
import type { ToolRegistry } from "../../kernel/registry.js";
import type { AuditSink } from "../../kernel/audit.js";

function kaynak(n: number) {
  return { system: "İşlem planları", kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

/**
 * @param getRegistry Registry TEMBEL geliyor: plan tool'ları
 *   registry'nin İÇİNDE kuruluyor ve o an henüz oluşmamış oluyor.
 *   `watchTools` de aynı sebeple aynı şeyi yapıyor.
 */
export function planTools(
  repo: PlanRepository,
  getRegistry: () => ToolRegistry,
  getAudit: () => AuditSink,
) {
  const create = defineTool({
    name: "create_operation_plan",
    module: "briefing",
    authority: 0,
    description: {
      tr:
        "Çok adımlı bir işi PLAN olarak hazırlar: sıralı adımlar, her biri bir tool " +
        "çağrısı. Hiçbir şeyi çalıştırmaz — yalnızca listeyi üretir ve kullanıcının " +
        "önüne koyar. 'Şu üç müşteriye fatura kes ve e-Fatura gönder' gibi birden " +
        "çok yazma işlemi gereken isteklerde ÖNCE bunu kullan; adımları tek tek " +
        "çağırmak kullanıcıyı altı kez onaylatır ve ara adım düşerse gerisi " +
        "sessizce kaybolur. Onaydan sonra run_operation_plan ile koşar.",
      en: "Prepares a multi-step operation plan without executing anything.",
    },
    input: z.strictObject({
      title: z.string().trim().min(3).max(160).describe("Planın adı. Örn. 'Ağustos faturaları ve e-Fatura'."),
      question: z.string().trim().max(500).nullable().describe("Planı doğuran kullanıcı isteği; yoksa null."),
      steps: z
        .array(
          z.strictObject({
            seq: z.number().int().positive().describe("Sıra numarası, 1'den başlar."),
            tool: z.string().trim().min(1).max(80).describe("Çağrılacak tool'un adı."),
            description: z
              .string()
              .trim()
              .min(3)
              .max(200)
              .describe("Bu adım ne yapıyor — KULLANICI OKUYACAK, tool adı değil cümle yaz."),
            input: z.record(z.string(), z.unknown()).describe("Tool'un girdisi, tam ve eksiksiz."),
          }),
        )
        .min(1)
        .max(25)
        .describe("Sıralı adımlar."),
    }),
    requires: ["briefing:watch.read"],
    async execute(input, ctx) {
      const adimlar: PlanStep[] = input.steps.map((s) => ({
        seq: s.seq,
        tool: s.tool,
        input: s.input,
        description: s.description,
      }));

      let yetki: number;
      try {
        assertSteps(adimlar);
        yetki = requiredAuthority(adimlar, (t) => getRegistry().get(t)?.authority ?? null);
      } catch (e) {
        if (e instanceof PlanError) throw new BusinessRuleError(e.message, "plan_invalid");
        throw e;
      }

      /*
       * PLANI YAZAN, ADIMLARI ÇAĞIRABİLEN OLMALI.
       *
       * Yetkisi yetmeyen bir kullanıcının yazdığı plan koşum anında
       * zaten reddedilirdi; ama o noktada kullanıcı planı onaylamış
       * ve bir şey olmasını beklemiş olur. Burada söylemek, orada
       * hayal kırıklığı yaratmaktan iyidir.
       */
      const reg = getRegistry();
      const gorunmeyen = adimlar.filter((s) => {
        const t = reg.get(s.tool);
        return !t || reg.missingFor(ctx.principal, s.tool).length > 0;
      });
      if (gorunmeyen.length > 0) {
        throw new BusinessRuleError(
          `Şu adımlar için yetkiniz yok: ` +
            gorunmeyen.map((s) => `${s.seq}. ${s.tool}`).join(", ") +
            `. Yetkiniz olmayan bir adımı plana koymak, onayladıktan sonra ` +
            `reddedilmesi demektir.`,
          "plan_permission_denied",
        );
      }
      if (yetki > ctx.principal.maxAuthority) {
        throw new BusinessRuleError(
          `Planın gerektirdiği yetki seviyesi ${yetki}, sizin seviyeniz ` +
            `${ctx.principal.maxAuthority}. Plan yetki yükseltmez.`,
          "plan_authority_exceeded",
        );
      }

      const no = await repo.nextNo(ctx.now().getUTCFullYear());
      const res = await repo.create({
        documentNo: no,
        title: input.title,
        question: input.question,
        requiredAuthority: yetki,
        steps: adimlar,
        userId: ctx.principal.userId,
        conversationId: null,
      });

      return {
        ok: true as const,
        data: {
          documentNo: res.documentNo,
          title: input.title,
          stepCount: adimlar.length,
          requiredAuthority: yetki,
          status: "draft",
          steps: adimlar.map((s) => ({ seq: s.seq, tool: s.tool, description: s.description })),
        },
        sources: [kaynak(1)],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${res.documentNo}: ${adimlar.length} adımlık plan HAZIRLANDI, hiçbiri ` +
              `çalıştırılmadı. Adımları okuyun; onayladıktan sonra sırayla koşacak ve ` +
              `bir adım düşerse SONRAKİLER HİÇ DENENMEYECEK.`,
          },
        ],
        confidence: 96,
      };
    },
  });

  const get = defineTool({
    name: "get_operation_plan",
    module: "briefing",
    authority: 0,
    description: {
      tr:
        "Bir işlem planını ve adım adım durumunu döndürür: hangisi tamamlandı, " +
        "hangisi düştü, hangisi hiç denenmedi. 'Plan ne oldu', 'işlem durumu' " +
        "sorularında kullan.",
      en: "Returns an operation plan with per-step status.",
    },
    input: z.strictObject({
      documentNo: z.string().trim().min(1).max(40).describe("Plan belge numarası."),
    }),
    requires: ["briefing:watch.read"],
    async execute(input, ctx) {
      const p = await repo.find(input.documentNo, ctx.principal.userId);
      return {
        ok: true as const,
        data: {
          found: p !== null,
          message: p ? "" : `${input.documentNo} numaralı plan bulunamadı.`,
          plan: p,
        },
        sources: [kaynak(p ? 1 : 0)],
        risks: [],
        confidence: 97,
      };
    },
  });

  const list = defineTool({
    name: "list_operation_plans",
    module: "briefing",
    authority: 0,
    description: {
      tr: "Hazırladığınız işlem planlarını listeler; en yeni başta.",
      en: "Lists your operation plans, newest first.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(50).describe("Kaç plan döndürülsün."),
    }),
    requires: ["briefing:watch.read"],
    async execute(input, ctx) {
      const rows = await repo.listFor(ctx.principal.userId, input.limit);
      const yarim = rows.filter((r) => r.status === "failed");
      return {
        ok: true as const,
        data: { total: rows.length, plans: rows },
        sources: [kaynak(rows.length)],
        risks:
          yarim.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${yarim.length} plan YARIDA KALDI: ${yarim.map((r) => r.documentNo).join(", ")}. ` +
                    `Yarım kalan bir plan, yapıldığı sanılan ama yapılmamış işler demektir.`,
                },
              ]
            : [],
        confidence: 97,
      };
    },
  });

  const cancel = defineTool({
    name: "cancel_operation_plan",
    module: "briefing",
    authority: 1,
    description: {
      tr:
        "Henüz koşmamış bir planı iptal eder. Koşmuş bir plan iptal EDİLEMEZ — " +
        "iptal etmek yapılanı geri almaz.",
      en: "Cancels a plan that has not run yet.",
    },
    input: z.strictObject({
      documentNo: z.string().trim().min(1).max(40).describe("Plan belge numarası."),
    }),
    requires: ["briefing:watch.write"],
    async execute(input, ctx) {
      await repo.cancel(input.documentNo, ctx.principal.userId);
      return {
        ok: true as const,
        data: { documentNo: input.documentNo, status: "cancelled" },
        sources: [kaynak(1)],
        risks: [{ severity: "info" as const, message: `${input.documentNo} iptal edildi.` }],
        confidence: 99,
      };
    },
  });

  /*
   * KOŞUM TOOL'U L3.
   *
   * Planın kendi `requiredAuthority` değeri koşum anında ayrıca
   * kontrol ediliyor; buradaki 3, tool'un KATALOG seviyesidir ve en
   * yüksek olasılığa göre konmuştur. Daha düşük olsaydı, L3 adım
   * içeren bir plan L2 onay kapısından geçerdi.
   */
  const run = defineTool({
    name: "run_operation_plan",
    module: "briefing",
    authority: 3,
    description: {
      tr:
        "Onaylanmış bir işlem planını SIRAYLA çalıştırır. Her adımın sonucu ayrı " +
        "kaydedilir. BİR ADIM DÜŞERSE PLAN DURUR ve sonraki adımlar HİÇ DENENMEZ — " +
        "yarı tutarlı veri üretmemek için. Sonuçta hangi adım yapıldı, hangisi " +
        "düştü, hangisi denenmedi ayrı ayrı bildirilir. Koşmuş bir plan yeniden " +
        "koşturulamaz.",
      en: "Runs an approved plan step by step, stopping at the first failure.",
    },
    input: z.strictObject({
      documentNo: z.string().trim().min(1).max(40).describe("Plan belge numarası."),
      confirmSteps: z
        .array(z.string().trim().min(1).max(240))
        .min(1)
        .max(25)
        .describe(
          "Onay formunda GÖRÜNECEK adım listesi: her satır '<sıra>. <açıklama>' " +
            "biçiminde ve plandaki açıklamayla BİREBİR aynı olmalı. Sunucu bunu " +
            "kayıtlı planla karşılaştırır ve tutmazsa koşumu reddeder.",
        ),
    }),
    requires: ["briefing:watch.write"],
    async execute(input, ctx) {
      const plan = await repo.find(input.documentNo, ctx.principal.userId);
      if (!plan) {
        throw new BusinessRuleError(
          `${input.documentNo} numaralı plan bulunamadı.`,
          "plan_not_found",
        );
      }

      /*
       * ONAY BİLGİLENDİRİLMİŞ OLMAK ZORUNDA — ayrıntı domain'de.
       * Bu kural planın güvenlik dayanağı olduğu için saf bir
       * fonksiyonda ve tek tek test edilmiş durumda.
       */
      try {
        assertConfirmationMatches(plan.steps, input.confirmSteps);
      } catch (e) {
        if (e instanceof PlanError) {
          throw new BusinessRuleError(e.message, "plan_confirmation_mismatch");
        }
        throw e;
      }

      try {
        assertRunnable(plan.status);
      } catch (e) {
        if (e instanceof PlanError) throw new BusinessRuleError(e.message, "plan_not_runnable");
        throw e;
      }

      if (plan.requiredAuthority > ctx.principal.maxAuthority) {
        throw new BusinessRuleError(
          `Bu plan ${plan.requiredAuthority}. seviye yetki gerektiriyor; sizin ` +
            `seviyeniz ${ctx.principal.maxAuthority}.`,
          "plan_authority_exceeded",
        );
      }

      // YARIŞA KAPALI BAŞLATMA: iki eşzamanlı koşumdan biri durur.
      if (!(await repo.begin(input.documentNo, ctx.principal.userId, ctx.now()))) {
        throw new BusinessRuleError(
          `${input.documentNo} şu anda başka bir istekle koşuyor ya da durumu değişti. ` +
            `Aynı planı iki kez koşturmak aynı kayıtları iki kez üretir.`,
          "plan_already_running",
        );
      }

      const sonuclar: StepOutcome[] = [];
      const adimlar = [...plan.steps].sort((a, b) => a.seq - b.seq);
      let dusen: number | null = null;

      for (const adim of adimlar) {
        if (dusen !== null) break;

        const invoked = await invokeTool(adim.tool, adim.input, {
          registry: getRegistry(),
          audit: getAudit(),
          principal: ctx.principal,
          tenant: ctx.tenant,
          correlationId: `plan-${plan.documentNo}-${adim.seq}`,
          channel: ctx.channel,
          now: ctx.now,
          /*
           * ADIMLAR ONAYLI KOŞAR — VE BU, ONAY KAPISININ AŞILMASI
           * DEĞİL, TAM OLARAK KENDİSİDİR.
           *
           * Bu tool'un kendisi onay kapısından geçti ve kullanıcı
           * yukarıda doğrulanmış adım listesini görerek onayladı.
           * Her adımın ayrıca onay istemesi, planı anlamsız kılardı:
           * kullanıcı yine altı kez tıklardı ve feature hiçbir şey
           * çözmezdi.
           *
           * Güvenliğin dayanağı üç şey: (1) plan yetki yükseltmez,
           * (2) her adım yine RBAC'ten geçer, (3) onaylanan liste ile
           * koşan liste sunucuda eşleştirilir.
           */
          confirmed: true,
        });

        if (invoked.outcome.ok) {
          const ozet = ozetle(invoked.outcome);
          sonuclar.push({
            seq: adim.seq,
            tool: adim.tool,
            description: adim.description,
            status: "done",
            summary: ozet,
            errorCode: null,
          });
          await repo.recordStep({
            planId: plan.id,
            seq: adim.seq,
            status: "done",
            summary: ozet,
            errorCode: null,
            at: ctx.now(),
          });
          continue;
        }

        /*
         * ONAY BEKLEYEN ADIM DA BAŞARISIZLIKTIR — PLAN İÇİNDE.
         *
         * Plan zaten bir onaydır; içindeki bir adımın ikinci kez onay
         * istemesi, planın anlamını ortadan kaldırır. Böyle bir adım
         * plana hiç girmemeliydi ve girdiyse plan durmalı.
         */
        const kod = invoked.outcome.code ?? "unknown";
        dusen = adim.seq;
        sonuclar.push({
          seq: adim.seq,
          tool: adim.tool,
          description: adim.description,
          status: "failed",
          summary: null,
          errorCode: kod,
        });
        await repo.recordStep({
          planId: plan.id,
          seq: adim.seq,
          status: "failed",
          summary: invoked.outcome.message ?? null,
          errorCode: kod,
          at: ctx.now(),
        });
      }

      if (dusen !== null) {
        for (const seq of planAfterFailure(adimlar, dusen).skipped) {
          const a = adimlar.find((x) => x.seq === seq)!;
          sonuclar.push({
            seq,
            tool: a.tool,
            description: a.description,
            status: "skipped",
            summary: null,
            errorCode: null,
          });
          await repo.recordStep({
            planId: plan.id,
            seq,
            status: "skipped",
            summary: null,
            errorCode: null,
            at: ctx.now(),
          });
        }
      }

      const rapor = buildReport(plan.documentNo, sonuclar);
      await repo.finish(plan.id, rapor.status, ctx.now());

      return {
        ok: true as const,
        data: rapor,
        sources: [kaynak(sonuclar.length)],
        risks: [
          {
            severity: rapor.failedCount > 0 ? ("critical" as const) : ("info" as const),
            message: rapor.summary,
          },
          ...(rapor.resumable.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${rapor.resumable.length} adım hiç denenmedi (${rapor.resumable.join(", ")}). ` +
                    `Düşen adımın sebebi çözülürse bunlar hâlâ yapılabilir — ama ` +
                    `bu plan yeniden koşmaz; yeni bir plan gerekir.`,
                },
              ]
            : []),
        ],
        confidence: 97,
      };
    },
  });

  return [create, get, list, cancel, run] as const;
}

/** Adım sonucundan tek satırlık özet. */
function ozetle(outcome: { data?: unknown }): string {
  const d = outcome.data;
  if (typeof d !== "object" || d === null) return "tamamlandı";
  const o = d as Record<string, unknown>;
  // Belge numarası varsa en anlamlı özet odur: kullanıcı onu arar.
  for (const k of ["documentNo", "code", "id"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "tamamlandı";
}
