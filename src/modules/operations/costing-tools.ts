/**
 * İş emri maliyeti tool'ları.
 *
 * MALİYET RAPORU L0'DIR ama herkese açık değildir: bir ürünün maliyeti,
 * kâr marjını gösterir ve operatörün görmesi gereken bir bilgi değildir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { CostingRepository } from "../../db/costing-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

export function costingTools(repo: CostingRepository) {
  const report = defineTool({
    name: "get_work_order_cost",
    module: "operations",
    authority: 0,
    description: {
      tr:
        "Bir iş emrinin fiili maliyetini döndürür: direkt malzeme (710), direkt " +
        "işçilik (720) ve genel üretim gideri (730) ayrı ayrı, birim maliyet ve " +
        "standarttan SAPMA ile birlikte. Maliyeti bilinmeyen unsurlar toplama " +
        "GİRMEZ, ayrıca sayılır — bilinmeyeni sıfır saymak ürünü olduğundan ucuz " +
        "gösterir. 'Bu iş emri kaça mal oldu', 'neden pahalıya geldi' sorularında kullan.",
      en: "Returns actual cost of a work order by element, with variance against standard.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(1).max(64).describe("İş emri numarası."),
    }),
    requires: ["operations:cost.read"],
    async execute(input, _ctx) {
      const r = await repo.report(input.workOrderId);
      if (!r) {
        return {
          ok: true as const,
          data: null,
          sources: [
            {
              system: "İş emri maliyeti",
              kind: "module" as const,
              recordCount: 0,
              syncedAt: new Date().toISOString(),
            },
          ],
          risks: [
            {
              severity: "warning" as const,
              message: `"${input.workOrderId}" numaralı iş emri bulunamadı.`,
            },
          ],
          confidence: 90,
        };
      }

      return {
        ok: true as const,
        data: {
          workOrderId: r.workOrderId,
          itemCode: r.itemCode,
          plannedQuantity: r.plannedQuantity,
          producedQuantity: r.producedQuantity,
          material: r.actual.material,
          labor: r.actual.labor,
          overhead: r.actual.overhead,
          totalCost: r.actual.total,
          actualUnitCost: r.variance.actualUnitCost,
          standardUnitCost: r.variance.standardUnitCost,
          unitVariance: r.variance.unitVariance,
          variancePercent: r.variance.variancePercent,
          severity: r.variance.severity,
          byElement: r.byElement,
          summary:
            `${r.workOrderId}: toplam ${TR.format(r.actual.total)} TL ` +
            `(malzeme ${TR.format(r.actual.material)}, işçilik ${TR.format(r.actual.labor)}, ` +
            `GÜG ${TR.format(r.actual.overhead)}). ${r.variance.explanation}`,
        },
        sources: [
          {
            system: "İş emri maliyeti",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(r.variance.severity === "kritik"
            ? [
                {
                  severity: "critical" as const,
                  message: r.variance.explanation,
                },
              ]
            : r.variance.severity === "dikkat"
              ? [{ severity: "warning" as const, message: r.variance.explanation }]
              : []),
          // BİLİNMEYEN UNSURLAR AYRI SÖYLENİR: toplam, eksik bir toplamdır.
          ...r.actual.unknowns.map((u) => ({ severity: "warning" as const, message: u })),
        ],
        confidence: r.actual.unknowns.length > 0 ? 65 : 92,
      };
    },
  });

  return [report] as const;
}
