/**
 * HR / Workforce tool'ları.
 *
 * Bu modül alan seviyesi maskelemeyi kanıtlar: üretim müdürü kendi
 * departmanının mesai verisini görür ama maaşı GÖREMEZ. Tool seviyesi izin
 * yeterli değildir; `redact` alan seviyesinde uygular.
 */

import { z } from "zod";
import { caveatRisks, confidenceWithCaveats } from "../../data/caveats.js";
import { defineTool } from "../../kernel/tool.js";
import { redactFields } from "../../kernel/rbac.js";
import type { DataSource, OvertimeRecord } from "../../data/port.js";

export function hrTools(db: DataSource) {
  const getOvertime = defineTool({
    name: "get_overtime",
    module: "hr",
    authority: 0,
    description: {
      tr: "Çalışan fazla mesai kayıtlarını döndürür: hafta içi, hafta sonu ve onay bekleyen dakikalar. Çalışan adı veya departman ile filtrelenir. 'Kaç saat mesaiye kaldı', 'departman mesaisi' sorularında kullan.",
      en: "Employee overtime records: weekday, weekend and pending-approval minutes, filterable by employee or department.",
    },
    input: z.strictObject({
      employeeQuery: z
        .string()
        .min(2)
        .nullable()
        .describe("Çalışan adının bir bölümü. Departman sorgusunda null gönder."),
      department: z
        .string()
        .min(2)
        .nullable()
        .describe("Departman adı. Kişi sorgusunda null gönder."),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .describe("Dönem, YYYY-AA biçiminde. Örn. 2026-05"),
    }),
    requires: ["hr:overtime.read"],
    async execute(input, ctx) {
      const { rows, freshness, caveats } = await db.overtime(ctx.tenant.tenantId, input);
      const pending = rows.reduce((s, r) => s + r.pendingApprovalMinutes, 0);
      return {
        ok: true,
        data: rows,
        sources: [
          { system: "PDKS", kind: "integrator", recordCount: rows.length, syncedAt: freshness.syncedAt },
          { system: "Vardiya planı", kind: "module", recordCount: rows.length, syncedAt: freshness.syncedAt },
        ],
        risks: [
          ...(pending > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${Math.round(pending / 60)} saatlik mesai hâlâ yönetici onayı bekliyor; tutar kesinleşmemiştir.`,
                },
              ]
            : []),
          ...caveatRisks(caveats),
        ],
        confidence: confidenceWithCaveats(pending > 0 ? 74 : 90, caveats),
      };
    },
    /**
     * Maaş özel kategori sayılır: yalnızca `hr:payroll.read` iznine sahip
     * roller görebilir. Diğerlerinde alan maskelenir — tool erişimi engellenmez.
     */
    redact(data: readonly OvertimeRecord[], principal) {
      return data.map((row) =>
        redactFields(
          row as unknown as Record<string, unknown>,
          [{ field: "grossSalaryTry", requires: "hr:payroll.read" }],
          principal,
        ),
      ) as unknown as readonly OvertimeRecord[];
    },
  });

  return [getOvertime] as const;
}
