/**
 * Bakım tool'ları.
 *
 * ARIZA BİLDİRMEK L1'DİR VE OPERATÖRE AÇIKTIR. Yüksek bir yetki
 * istenseydi operatör arızayı ustabaşına sözlü söyler, kayıt hiç
 * oluşmaz ve "bu tezgâh ayda kaç kez duruyor" sorusu cevapsız kalırdı.
 * Bildirimi zorlaştırmak, bildirimi yok etmektir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { MaintenanceRepository } from "../../db/maintenance-repository.js";
import { BREAKDOWN_SEVERITIES, MAINTENANCE_KINDS } from "./maintenance.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

export function maintenanceTools(repo: MaintenanceRepository) {
  const due = defineTool({
    name: "list_due_maintenance",
    module: "maintenance",
    authority: 0,
    description: {
      tr:
        "Zamanı gelen ve geciken bakımları listeler. SAYAÇ VARSA SAYACA, yoksa " +
        "takvime göre hesaplanır ve hangisinin kullanıldığı söylenir — 'her 3 ayda " +
        "bir' kuralı az çalışan tezgâhı gereksiz durdurur, çok çalışanı geç yakalar. " +
        "'Hangi makinelerin bakımı geldi' sorusunda kullan.",
      en: "Lists due and overdue maintenance, using meter readings when available.",
    },
    input: z.strictObject({}),
    requires: ["maintenance:plan.read"],
    async execute(_input, ctx) {
      const rows = await repo.duePlans(ctx.now());
      const dueRows = rows.filter((r) => r.due);
      const unknown = rows.filter((r) => r.basis === "bilinmiyor");

      return {
        ok: true as const,
        data: { plans: rows, dueCount: dueRows.length },
        sources: [
          {
            system: "Bakım planları",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(dueRows.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${dueRows.length} makinenin bakımı geldi. En gecikmişi: ` +
                    `${dueRows[0]!.machineCode} — ${dueRows[0]!.explanation}`,
                },
              ]
            : []),
          ...(unknown.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${unknown.length} planın bakım zamanı HESAPLANAMIYOR (aralık ya da ` +
                    `son bakım tarihi eksik). 'Zamanı gelmedi' DEĞİL, 'bilinmiyor'.`,
                },
              ]
            : []),
        ],
        confidence: unknown.length > 0 ? 75 : 93,
      };
    },
  });

  const savePlan = defineTool({
    name: "set_maintenance_plan",
    module: "maintenance",
    authority: 1,
    description: {
      tr:
        "Bir makineye bakım planı tanımlar. Takvim aralığı (gün) veya SAYAÇ aralığı " +
        "(çalışma saati) verilmelidir; ikisi de yoksa plan hiçbir zaman tetiklenmez " +
        "ve 'bakım planımız var' yanılsaması doğar. Sayaç, takvimden daha doğrudur.",
      en: "Defines a maintenance plan by calendar or meter interval.",
    },
    input: z.strictObject({
      machineCode: z.string().min(1).max(64).describe("Makine kodu."),
      description: z.string().min(3).max(200).describe("Yapılacak bakımın tanımı."),
      intervalDays: z.number().int().positive().nullable().describe("Takvim aralığı (gün)."),
      intervalHours: z.number().positive().nullable().describe("Sayaç aralığı (çalışma saati)."),
      lastDoneAt: z.string().nullable().describe("Son bakım tarihi (ISO 8601). Yoksa null."),
      lastDoneHours: z.number().nonnegative().nullable().describe("Son bakımdaki sayaç değeri."),
    }),
    requires: ["maintenance:plan.write"],
    async execute(input, _ctx) {
      const r = await repo.savePlan({
        machineCode: input.machineCode,
        description: input.description,
        intervalDays: input.intervalDays,
        intervalHours: input.intervalHours,
        lastDoneAt: input.lastDoneAt ? new Date(input.lastDoneAt) : null,
        lastDoneHours: input.lastDoneHours,
      });
      return {
        ok: true as const,
        data: { id: r.id, machineCode: input.machineCode },
        sources: [
          {
            system: "Bakım planları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${input.machineCode} için bakım planı tanımlandı` +
              (input.intervalHours !== null
                ? ` (her ${input.intervalHours} çalışma saatinde).`
                : ` (her ${input.intervalDays} günde).`),
          },
        ],
        confidence: 97,
      };
    },
  });

  const report = defineTool({
    name: "report_breakdown",
    module: "maintenance",
    authority: 1,
    description: {
      tr:
        "Arıza bildirir. ÖNCELİĞİ 'ACİL' ETİKETİ DEĞİL ÜRETİME ETKİSİ belirler: " +
        "hattı durdurdu mu, yavaşlattı mı, etkilemedi mi. Üretimi DURDURAN arıza " +
        "kendiliğinden bakım iş emri açar — en pahalı arıza için en yavaş yol " +
        "izlenmemeli.",
      en: "Reports a machine breakdown; a production-stopping one opens a work order.",
    },
    input: z.strictObject({
      machineCode: z.string().min(1).max(64).describe("Makine kodu."),
      severity: z
        .enum(BREAKDOWN_SEVERITIES)
        .describe("durdurdu | yavaslatti | etkilemedi — üretime etkisi."),
      description: z.string().min(5).max(500).describe("Ne oldu?"),
      reportedAt: z.string().describe("Arızanın fark edildiği an (ISO 8601)."),
    }),
    requires: ["maintenance:breakdown.report"],
    async execute(input, ctx) {
      const r = await repo.reportBreakdown({
        machineCode: input.machineCode,
        severity: input.severity,
        description: input.description,
        reportedAt: new Date(input.reportedAt),
        userId: ctx.principal.userId,
      });
      return {
        ok: true as const,
        data: { breakdownId: r.breakdownId, orderNo: r.orderNo, severity: input.severity },
        sources: [
          {
            system: "Arıza bildirimleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: input.severity === "durdurdu" ? ("critical" as const) : ("warning" as const),
            message:
              input.severity === "durdurdu"
                ? `${input.machineCode} ÜRETİMİ DURDURDU. ${r.orderNo} bakım iş emri ` +
                  `kendiliğinden açıldı.`
                : `${input.machineCode} arızası kaydedildi (${input.severity}).`,
          },
        ],
        confidence: 97,
      };
    },
  });

  const resolve = defineTool({
    name: "resolve_breakdown",
    module: "maintenance",
    authority: 1,
    description: {
      tr:
        "Arızayı kapatır ve duruş süresini hesaplar. KÖK NEDEN ZORUNLUDUR — aynı " +
        "arıza tekrar ettiğinde ilk bakılacak yer burasıdır; boş bırakılırsa her " +
        "seferinde sıfırdan aranır.",
      en: "Closes a breakdown and computes downtime. Root cause is mandatory.",
    },
    input: z.strictObject({
      breakdownId: z.string().min(1).describe("Arıza kaydı kimliği."),
      resolvedAt: z.string().describe("Giderildiği an (ISO 8601)."),
      rootCause: z.string().min(5).max(500).describe("Kök neden — neden oldu?"),
    }),
    requires: ["maintenance:breakdown.report"],
    async execute(input, _ctx) {
      const r = await repo.resolveBreakdown({
        breakdownId: input.breakdownId,
        resolvedAt: new Date(input.resolvedAt),
        rootCause: input.rootCause,
      });
      return {
        ok: true as const,
        data: { breakdownId: input.breakdownId, downtimeHours: r.downtimeHours },
        sources: [
          {
            system: "Arıza bildirimleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message: `Arıza kapatıldı; duruş süresi ${r.downtimeHours} saat.`,
          },
        ],
        confidence: 96,
      };
    },
  });

  const openList = defineTool({
    name: "list_open_breakdowns",
    module: "maintenance",
    authority: 0,
    description: {
      tr:
        "Devam eden arızaları listeler; üretimi durduranlar başta. " +
        "'Şu an hangi tezgâhlar arızalı' sorusunda kullan.",
      en: "Lists unresolved breakdowns, production-stopping first.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(200).describe("En fazla kaç kayıt."),
    }),
    requires: ["maintenance:machine.read"],
    async execute(input, _ctx) {
      const rows = await repo.openBreakdowns(input.limit);
      const stopping = rows.filter((r) => r.severity === "durdurdu");
      return {
        ok: true as const,
        data: { breakdowns: rows, stoppingCount: stopping.length },
        sources: [
          {
            system: "Arıza bildirimleri",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          stopping.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${stopping.length} makine ÜRETİMİ DURDURAN arızayla bekliyor: ` +
                    stopping.map((s) => s.machineCode).join(", ") + ".",
                },
              ]
            : [],
        confidence: 96,
      };
    },
  });

  const createOrder = defineTool({
    name: "create_maintenance_order",
    module: "maintenance",
    authority: 1,
    description: {
      tr: "Planlı bakım iş emri açar. Arıza iş emirleri bildirimle kendiliğinden açılır.",
      en: "Opens a planned maintenance work order.",
    },
    input: z.strictObject({
      machineCode: z.string().min(1).max(64).describe("Makine kodu."),
      kind: z.enum(MAINTENANCE_KINDS).describe("planli | ariza | kestirimci"),
      description: z.string().min(3).max(300).describe("Yapılacak iş."),
      scheduledFor: z.string().nullable().describe("Planlanan tarih (ISO 8601). Yoksa null."),
    }),
    requires: ["maintenance:order.write"],
    async execute(input, ctx) {
      const r = await repo.createOrder({
        machineCode: input.machineCode,
        kind: input.kind,
        description: input.description,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        userId: ctx.principal.userId,
        at: ctx.now(),
      });
      return {
        ok: true as const,
        data: { documentNo: r.documentNo, machineCode: input.machineCode },
        sources: [
          {
            system: "Bakım iş emirleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          { severity: "info" as const, message: `${r.documentNo} bakım iş emri açıldı.` },
        ],
        confidence: 97,
      };
    },
  });

  const complete = defineTool({
    name: "complete_maintenance_order",
    module: "maintenance",
    authority: 1,
    description: {
      tr:
        "Bakım iş emrini tamamlar: harcanan işçilik, yedek parça maliyeti ve YAPILAN " +
        "İŞİN KAYDI. Plana bağlıysa son bakım tarihi güncellenir — güncellenmezse " +
        "bakım sonsuza kadar 'gecikmiş' görünür ve bir süre sonra kimse listeye bakmaz.",
      en: "Completes a maintenance order and updates the plan's last-done date.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Bakım iş emri numarası."),
      completedAt: z.string().describe("Tamamlanma anı (ISO 8601)."),
      laborHours: z.number().nonnegative().nullable().describe("Harcanan işçilik (saat)."),
      partsCost: z.number().nonnegative().nullable().describe("Yedek parça maliyeti (TL)."),
      findings: z.string().min(5).max(1000).describe("Ne yapıldı, ne bulundu?"),
      currentHours: z.number().nonnegative().nullable().describe("Bakım anındaki sayaç değeri."),
    }),
    requires: ["maintenance:order.write"],
    async execute(input, _ctx) {
      const r = await repo.completeOrder({
        documentNo: input.documentNo,
        completedAt: new Date(input.completedAt),
        laborHours: input.laborHours,
        partsCost: input.partsCost,
        findings: input.findings,
        currentHours: input.currentHours,
      });
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Bakım iş emirleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${r.documentNo} tamamlandı` +
              (r.planUpdated ? "; bakım planının son yapılma tarihi güncellendi." : "."),
          },
        ],
        confidence: 97,
      };
    },
  });

  const history = defineTool({
    name: "get_machine_maintenance_history",
    module: "maintenance",
    authority: 0,
    description: {
      tr:
        "Bir makinenin bakım ve arıza geçmişini döndürür: ne yapıldı, ne bulundu, " +
        "kök nedenler. Aynı arıza tekrar ettiğinde İLK BAKILACAK YER burasıdır — " +
        "ustabaşının aklındaki bilgi, ustabaşı ayrılınca gitmesin.",
      en: "Returns a machine's maintenance and breakdown history with root causes.",
    },
    input: z.strictObject({
      machineCode: z.string().min(1).max(64).describe("Makine kodu."),
      limit: z.number().int().positive().max(100).describe("En fazla kaç kayıt."),
    }),
    requires: ["maintenance:machine.read"],
    async execute(input, _ctx) {
      const r = await repo.machineHistory(input.machineCode, input.limit);
      const repeated = new Map<string, number>();
      for (const b of r.breakdowns) {
        if (!b.rootCause) continue;
        repeated.set(b.rootCause, (repeated.get(b.rootCause) ?? 0) + 1);
      }
      const recurring = [...repeated.entries()].filter(([, n]) => n >= 2);

      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Bakım geçmişi",
            kind: "module" as const,
            recordCount: r.orders.length + r.breakdowns.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          recurring.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `TEKRAR EDEN ARIZA: "${recurring[0]![0]}" bu makinede ` +
                    `${recurring[0]![1]} kez görüldü. Kök neden çözülmemiş olabilir.`,
                },
              ]
            : [],
        confidence: 94,
      };
    },
  });

  const kpi = defineTool({
    name: "get_maintenance_kpi",
    module: "maintenance",
    authority: 0,
    description: {
      tr:
        "Bakım göstergeleri: planlı bakım oranı, toplam duruş, üretimi durduran " +
        "duruş, MTBF (arızalar arası süre) ve MTTR (ortalama tamir süresi). " +
        "AZ VERİYLE MTBF/MTTR HESAPLANMAZ — üç arızadan eğilim çıkarmak, " +
        "rastlantıyı eğilim gibi sunmaktır.",
      en: "Maintenance KPIs: planned ratio, downtime, MTBF and MTTR.",
    },
    input: z.strictObject({
      from: z.string().describe("Başlangıç (ISO 8601)."),
      to: z.string().describe("Bitiş (ISO 8601)."),
    }),
    requires: ["maintenance:machine.read"],
    async execute(input, _ctx) {
      const k = await repo.kpi(new Date(input.from), new Date(input.to));
      return {
        ok: true as const,
        data: {
          ...k,
          summary:
            `${k.totalOrders} bakım işi (${k.plannedOrders} planlı, ${k.breakdownOrders} arıza)` +
            (k.plannedRatePercent !== null ? `, planlı oranı %${k.plannedRatePercent}` : "") +
            `. Toplam duruş ${TR.format(k.totalDowntimeHours)} saat, üretimi durduran ` +
            `${TR.format(k.productionStoppingHours)} saat.`,
        },
        sources: [
          {
            system: "Bakım göstergeleri",
            kind: "module" as const,
            recordCount: k.totalOrders,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...k.caveats.map((c) => ({ severity: "warning" as const, message: c })),
          ...(k.plannedRatePercent !== null && k.plannedRatePercent < 50 && k.totalOrders >= 5
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `Bakımların yalnızca %${k.plannedRatePercent}'i planlı. Arıza ağırlıklı ` +
                    `bir bakım düzeni, duruşu tahmin edilemez kılar.`,
                },
              ]
            : []),
        ],
        confidence: k.caveats.length > 0 ? 72 : 90,
      };
    },
  });

  return [due, savePlan, report, resolve, openList, createOrder, complete, history, kpi] as const;
}
