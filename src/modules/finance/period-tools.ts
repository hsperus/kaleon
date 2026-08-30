/**
 * Dönem kapama tool'ları.
 *
 * KAPAMA L3'TÜR ÇÜNKÜ GERİ ALINMASI İZ BIRAKIR. Dönem yeniden açılabilir,
 * ama açılma kaydı sebebiyle birlikte kalıcıdır ve denetimde görünür.
 * Kilitleme ise gerçekten geri alınamaz.
 *
 * KAPAMA ÖNCE ENGELLERİ GÖSTERİR. Engel varsa kapatmaz, sayar ve söyler:
 * "3 taslak fatura var" cümlesi, "kapatmadan önce kontrol ediniz"
 * uyarısından işe yarar bir şeydir. Zorla kapatmak mümkündür ama açıkça
 * istenmelidir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { PeriodRepository } from "../../db/period-repository.js";
import { periodLabel } from "./period.js";

export function periodTools(repo: PeriodRepository) {
  const status = defineTool({
    name: "get_period_status",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Bir yılın muhasebe dönemlerinin durumunu döndürür (açık / kapalı / kilitli) " +
        "ve istenirse belirli bir dönemin kapanmasını engelleyen kalemleri sayar. " +
        "'Mayıs kapandı mı', 'neden kapatamıyorum' sorularında kullan.",
      en: "Returns accounting period statuses and blockers for closing.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .nullable()
        .describe("Belirli bir ayın engellerini görmek için ay. Tüm yıl için null."),
    }),
    requires: ["accounting:period.read"],
    async execute(input, _ctx) {
      const periods = await repo.list(input.year);
      const blockers =
        input.month !== null ? await repo.blockersFor(input.year, input.month) : [];

      return {
        ok: true as const,
        data: {
          year: input.year,
          periods: periods.map((p) => ({
            month: p.month,
            label: periodLabel(p),
            status: p.status,
            closedAt: p.closedAt,
          })),
          blockers: blockers.map((b) => ({ kind: b.kind, count: b.count, message: b.message })),
        },
        sources: [
          {
            system: "Muhasebe dönemleri",
            kind: "module" as const,
            recordCount: periods.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: blockers.map((b) => ({ severity: "warning" as const, message: b.message })),
        confidence: 96,
      };
    },
  });

  const close = defineTool({
    name: "close_period",
    module: "accounting",
    authority: 3,
    description: {
      tr:
        "Muhasebe dönemini kapatır: o aya ARTIK KAYIT GİRİLEMEZ — hiç kimse " +
        "tarafından, patron dahil. Engel varsa kapatmaz ve engelleri sayar. " +
        "`force` verilirse engellere rağmen kapatır; bu açıkça istenmelidir.",
      en: "Closes an accounting period. Postings to that month become impossible.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z.number().int().min(1).max(12).describe("Ay."),
      force: z
        .boolean()
        .describe("Engellere rağmen kapatılsın mı? Varsayılan davranış: hayır."),
    }),
    requires: ["accounting:period.close"],
    async execute(input, ctx) {
      const res = await repo.close({
        year: input.year,
        month: input.month,
        userId: ctx.principal.userId,
        force: input.force,
      });

      const label = periodLabel({ year: input.year, month: input.month });
      const closed = res.status === "closed";

      return {
        ok: true as const,
        data: {
          year: input.year,
          month: input.month,
          label,
          status: res.status,
          closed,
          blockers: res.blockers.map((b) => ({ kind: b.kind, count: b.count })),
        },
        sources: [
          {
            system: "Muhasebe dönemleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: closed
          ? [
              {
                severity: "warning" as const,
                message:
                  `${label} kapatıldı; bu aya artık kayıt girilemez.` +
                  (res.blockers.length > 0
                    ? ` ${res.blockers.length} engele RAĞMEN kapatıldı: ` +
                      res.blockers.map((b) => `${b.kind} (${b.count})`).join(", ") + "."
                    : ""),
              },
            ]
          : res.blockers.map((b) => ({ severity: "critical" as const, message: b.message })),
        confidence: 98,
      };
    },
  });

  const reopen = defineTool({
    name: "reopen_period",
    module: "accounting",
    authority: 3,
    description: {
      tr:
        "Kapalı bir muhasebe dönemini yeniden açar. SEBEP ZORUNLUDUR ve kalıcı " +
        "olarak kaydedilir. Kilitli dönem açılamaz — yıl sonu bilançosu " +
        "onaylanmıştır.",
      en: "Reopens a closed accounting period. Reason is mandatory and recorded.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z.number().int().min(1).max(12).describe("Ay."),
      reason: z.string().min(5).max(300).describe("Neden açılıyor? Kalıcı olarak kaydedilir."),
    }),
    requires: ["accounting:period.close"],
    async execute(input, ctx) {
      await repo.reopen({
        year: input.year,
        month: input.month,
        userId: ctx.principal.userId,
        reason: input.reason,
      });
      const label = periodLabel({ year: input.year, month: input.month });
      return {
        ok: true as const,
        data: { year: input.year, month: input.month, label, status: "open" },
        sources: [
          {
            system: "Muhasebe dönemleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${label} yeniden açıldı. Bu döneme girilecek her kayıt, ` +
              `daha önce çıkarılmış mizanı ve beyannameyi değiştirir.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  return [status, close, reopen] as const;
}
