/**
 * Operations Core tool'ları.
 *
 * `get_factory_wip` çekirdek tool'dur (deferLoading: false) — patron ve üretim
 * müdürünün en sık sorduğu soru budur, her isteğe konar.
 */

import { z } from "zod";
import { caveatRisks, confidenceWithCaveats } from "../../data/caveats.js";
import { defineTool } from "../../kernel/tool.js";
import type { DataSource } from "../../data/port.js";
import type { Risk, ToolOk } from "../../kernel/types.js";

export function operationsTools(db: DataSource) {
  const getFactoryWip = defineTool({
    name: "get_factory_wip",
    module: "operations",
    authority: 0,
    deferLoading: false,
    description: {
      tr: "Fabrikanın anlık durumunu döndürür: aktif iş emri, vardiyadaki personel, çalışan makine, istasyon doluluk oranları ve gerçek üretim hızı. 'Şu an fabrikada ne oluyor', 'üretim nasıl gidiyor', 'hangi hat darboğaz' sorularında kullan.",
      en: "Live factory floor snapshot: active work orders, staffing, machine status, station utilisation and actual vs target throughput.",
    },
    input: z.strictObject({}),
    requires: ["operations:workorder.read"],
    async execute(_input, ctx): Promise<ToolOk<Awaited<ReturnType<DataSource["wipSnapshot"]>>["rows"]>> {
      const { rows, freshness } = await db.wipSnapshot(ctx.tenant.tenantId);

      const risks: Risk[] = [];
      const bottleneck = [...rows.stations].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];
      if (bottleneck && bottleneck.utilizationPct >= 90) {
        risks.push({
          severity: "critical",
          message: `${bottleneck.station} istasyonu %${bottleneck.utilizationPct} dolulukta — darboğaz.`,
          ref: bottleneck.station,
        });
      }
      const shortfall = 1 - rows.actualRatePerHour / rows.targetRatePerHour;
      if (shortfall >= 0.15) {
        risks.push({
          severity: "warning",
          message: `Üretim hızı hedefin %${Math.round(shortfall * 100)} altında (${rows.actualRatePerHour}/${rows.targetRatePerHour} birim-saat).`,
        });
      }
      const offline = rows.machinesTotal - rows.machinesRunning;
      if (offline > 0) {
        risks.push({
          severity: "info",
          message: `${offline} makine plan dışı duruşta.`,
        });
      }

      return {
        ok: true,
        data: rows,
        sources: [
          { system: "Saha terminalleri", kind: "module", recordCount: rows.activeWorkOrders, syncedAt: freshness.syncedAt },
          { system: "Makine telemetrisi", kind: "machine", recordCount: rows.machinesTotal, syncedAt: freshness.syncedAt },
        ],
        risks,
        confidence: rows.machinesRunning / rows.machinesTotal >= 0.8 ? 92 : 74,
      };
    },
  });

  const getShipmentRisk = defineTool({
    name: "get_shipment_risk",
    module: "operations",
    authority: 0,
    description: {
      tr: "Belirtilen hafta için sevkiyat gecikme riskini döndürür. Tarihler taahhüt değil, gerçek üretim akışından hesaplanmış tahmini tarihlerdir. 'Hangi siparişler gecikecek', 'sevkiyat riski var mı' sorularında kullan.",
      en: "Shipment slip risk for a given ISO week, computed from actual production flow rather than committed dates.",
    },
    input: z.strictObject({
      isoWeek: z
        .number()
        .int()
        .min(1)
        .max(53)
        .describe("ISO hafta numarası, örn. 19"),
    }),
    requires: ["operations:shipment.read"],
    async execute(input, ctx) {
      const { rows, freshness, caveats } = await db.shipmentRisks(
        ctx.tenant.tenantId,
        input.isoWeek,
      );
      const totalPenalty = rows.reduce((s, r) => s + r.penaltyRiskTry, 0);
      return {
        ok: true,
        data: rows,
        sources: [
          { system: "İş emri + kapasite planı", kind: "derived", recordCount: rows.length, syncedAt: freshness.syncedAt },
        ],
        risks: [
          ...(totalPenalty > 0
            ? [
                {
                  severity: "critical" as const,
                  message: `Toplam gecikme cezası riski yaklaşık ${totalPenalty.toLocaleString("tr-TR")} TL.`,
                },
              ]
            : []),
          // Tarihi bilinemeyen siparişler cevabın parçasıdır.
          ...caveatRisks(caveats),
        ],
        confidence: confidenceWithCaveats(88, caveats),
      };
    },
  });

  return [getFactoryWip, getShipmentRisk] as const;
}
