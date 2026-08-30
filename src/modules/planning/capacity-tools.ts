/**
 * Kapasite planlama tool'u.
 *
 * SONSUZ KAPASİTE VARSAYIMI PLANLAMANIN EN YAYGIN YALANIDIR: sistem her
 * siparişi kabul eder, her termini verir, sonra üretim "yetiştiremedik"
 * der. Bu tool o yalanı ölçülebilir kılar.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { CapacityRepository } from "../../db/capacity-repository.js";

export function capacityTools(repo: CapacityRepository) {
  const load = defineTool({
    name: "get_capacity_load",
    module: "operations",
    authority: 0,
    description: {
      tr:
        "İş merkezlerinin gün gün yükleme oranını döndürür: gereken saat, " +
        "kullanılabilir saat ve doluluk yüzdesi. KAPASİTESİ AŞILAN günler ayrıca " +
        "listelenir — o günlerdeki işler zamanında bitmez. Kapasitesi tanımsız " +
        "iş merkezi '%0 dolu' GÖSTERİLMEZ. 'Tezgâhlar yetecek mi', 'hangi hafta " +
        "sıkışığız' sorularında kullan.",
      en: "Returns work center load by day with overload detection.",
    },
    input: z.strictObject({
      onlyOverloaded: z.boolean().describe("Yalnızca kapasitesi aşan günler mi listelensin?"),
      limit: z.number().int().positive().max(300).describe("En fazla kaç satır."),
    }),
    requires: ["operations:planning.read"],
    async execute(input, _ctx) {
      const r = await repo.load();
      const rows = (input.onlyOverloaded ? r.overloaded : r.buckets).slice(0, input.limit);

      return {
        ok: true as const,
        data: {
          buckets: rows,
          overloadedCount: r.overloaded.length,
          totalBuckets: r.buckets.length,
        },
        sources: [
          {
            system: "Kapasite planlama",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(r.overloaded.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${r.overloaded.length} gün-iş merkezi kombinasyonunda kapasite ` +
                    `AŞILIYOR. En sıkışığı: ${r.overloaded[0]!.workCenter} ` +
                    `${r.overloaded[0]!.date} — %${r.overloaded[0]!.loadPercent} dolu ` +
                    `(${r.overloaded[0]!.requiredHours} saat gerekiyor, ` +
                    `${r.overloaded[0]!.availableHours} saat var).`,
                },
              ]
            : []),
          ...r.caveats
            .filter((c) => !c.includes("kapasite AŞILIYOR"))
            .map((c) => ({ severity: "warning" as const, message: c })),
          ...(r.skipped.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${r.skipped.length} operasyon plana GİRMEDİ (hedef hız ya da ` +
                    `planlanan bitiş eksik): ${r.skipped.slice(0, 3).join("; ")}` +
                    `${r.skipped.length > 3 ? "…" : ""}. Görünmeyen yük, sıkışıklığı ` +
                    `olduğundan az gösterir.`,
                },
              ]
            : []),
        ],
        confidence: r.caveats.length > 0 || r.skipped.length > 0 ? 72 : 90,
      };
    },
  });

  return [load] as const;
}
