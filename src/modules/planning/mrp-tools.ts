/**
 * MRP tool'ları.
 *
 * MRP OKUMA İŞLEMİDİR (L0): hiçbir şey yazmaz, plan önerir. Planlı
 * siparişi gerçek siparişe çevirmek ayrı ve yazma bir işlemdir — MRP'nin
 * kendisi otomatik sipariş vermez. Verseydi, hatalı bir termin tarihi
 * doğrudan tedarikçiye giden bir siparişe dönüşürdü.
 *
 * "YETİŞMİYOR" LİSTESİ AYRI DÖNER. Planın içine gömülseydi, 300 satırlık
 * bir listede kaybolur ve kimse okumazdı — oysa geciken kalem, planın
 * kendisinden önemli tek bilgidir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { MrpRepository } from "../../db/mrp-repository.js";

export function mrpTools(repo: MrpRepository) {
  const run = defineTool({
    name: "run_mrp",
    module: "operations",
    authority: 0,
    description: {
      tr:
        "Malzeme ihtiyaç planlaması çalıştırır: açık satış siparişlerinden yola " +
        "çıkıp ürün ağacını patlatır, eldeki stok ve yoldaki siparişleri düşer, " +
        "NEYİ NE ZAMAN sipariş etmek veya üretmek gerektiğini söyler. " +
        "ZAMANINDA YETİŞMEYECEK kalemler ayrıca listelenir. 'Neyi ne zaman " +
        "sipariş etmeliyim', 'malzeme yetecek mi', 'MRP çalıştır' sorularında kullan. " +
        "HİÇBİR ŞEY YAZMAZ; yalnızca plan önerir.",
      en: "Runs MRP: explodes BOMs against open demand and reports planned orders.",
    },
    input: z.strictObject({
      onlyLate: z
        .boolean()
        .describe("Yalnızca zamanında yetişmeyecek kalemler mi listelensin?"),
      limit: z.number().int().positive().max(300).describe("En fazla kaç planlı sipariş."),
    }),
    requires: ["operations:planning.read"],
    async execute(input, ctx) {
      const r = await repo.run(ctx.now());
      const rows = (input.onlyLate ? r.late : r.plannedOrders).slice(0, input.limit);
      const truncated = (input.onlyLate ? r.late.length : r.plannedOrders.length) - rows.length;

      return {
        ok: true as const,
        data: {
          plannedOrders: rows,
          totalPlanned: r.plannedOrders.length,
          lateCount: r.late.length,
          demandCount: r.demandCount,
          itemCount: r.itemCount,
        },
        sources: [
          {
            system: "Malzeme ihtiyaç planlaması",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(r.late.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${r.late.length} kalemin sipariş/üretim başlama tarihi GEÇMİŞTE kaldı; ` +
                    `bu kalemler zamanında yetişmeyecek. En kritiği: ` +
                    `${r.late[0]!.itemCode} (${r.late[0]!.lateByDays} gün geç, ` +
                    `${r.late[0]!.drivenBy}).`,
                },
              ]
            : []),
          ...r.caveats
            .filter((c) => !c.includes("zamanında yetişmeyecek"))
            .map((c) => ({ severity: "warning" as const, message: c })),
          ...(truncated > 0
            ? [
                {
                  severity: "info" as const,
                  message: `${truncated} planlı sipariş listeye sığmadı; sınırı artırın.`,
                },
              ]
            : []),
          ...(r.demandCount === 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    "Açık satış siparişi yok; plan boş. MRP talepten çalışır, " +
                    "talep yoksa üretilecek bir şey de yoktur.",
                },
              ]
            : []),
        ],
        confidence: r.caveats.length > 0 ? 78 : 92,
      };
    },
  });

  const forItem = defineTool({
    name: "get_material_requirement",
    module: "operations",
    authority: 0,
    description: {
      tr:
        "Tek bir malzemenin ihtiyaç durumunu döndürür: ne kadar lazım, ne kadar " +
        "var, ne kadar yolda, ne zaman sipariş edilmeli ve bu ihtiyacı hangi " +
        "sipariş doğuruyor. 'Şu hammadde yetecek mi' sorusunda kullan.",
      en: "Returns the planned requirement for a single material.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
    }),
    requires: ["operations:planning.read"],
    async execute(input, ctx) {
      const r = await repo.run(ctx.now());
      const rows = r.plannedOrders.filter((p) => p.itemCode === input.itemCode);
      const late = rows.filter((p) => p.lateByDays > 0);

      return {
        ok: true as const,
        data: { itemCode: input.itemCode, plannedOrders: rows },
        sources: [
          {
            system: "Malzeme ihtiyaç planlaması",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length === 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    `"${input.itemCode}" için planlı ihtiyaç yok: ya talep yok ya da ` +
                    `eldeki stok yetiyor.`,
                },
              ]
            : late.length > 0
              ? [
                  {
                    severity: "critical" as const,
                    message:
                      `${input.itemCode} için sipariş ${late[0]!.lateByDays} gün geç kalmış; ` +
                      `${late[0]!.startDate} tarihinde verilmiş olmalıydı.`,
                  },
                ]
              : [],
        confidence: 92,
      };
    },
  });

  return [run, forItem] as const;
}
