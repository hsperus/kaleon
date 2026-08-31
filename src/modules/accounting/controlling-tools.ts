/**
 * Maliyet muhasebesi tool'ları.
 *
 * DÖRT TOOL:
 *   create_cost_center      → merkez aç
 *   list_cost_centers       → ağacı gör
 *   set_budget              → dönem bütçesi gir
 *   get_budget_vs_actual    → sapma raporu
 *
 * `get_cost_center_report` ayrı bir tool DEĞİL: sapma raporu merkez
 * filtresi alıyor ve üst merkez sorulduğunda altını topluyor. İki
 * ayrı tool olsaydı ikisi zamanla farklı sayı üretirdi.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { budgetVsActual, descendantsOf, ControllingError } from "./controlling.js";
import type { ControllingRepository } from "../../db/controlling-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

export function controllingTools(repo: ControllingRepository) {
  const create = defineTool({
    name: "create_cost_center",
    module: "accounting",
    authority: 2,
    description: {
      tr:
        "Masraf merkezi açar: kod, ad, üst merkez ve sorumlu. Giderin hangi " +
        "departmana ait olduğunu bu merkez belirler. Üst merkez verilirse ağaç " +
        "kurulur ve üst merkez raporu altındakileri toplar. 'Departman ekle', " +
        "'masraf merkezi aç' isteklerinde kullan.",
      en: "Creates a cost center, optionally under a parent.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(30).describe("Merkez kodu, benzersiz. Örn. URT-KYN."),
      name: z.string().trim().min(2).max(120).describe("Merkez adı. Örn. Kaynakhane."),
      parentCode: z.string().trim().max(30).nullable().describe("Üst merkez kodu; kök merkez için null."),
      managerEmployeeCode: z.string().trim().max(40).nullable().describe("Sorumlunun personel kodu; bilinmiyorsa null."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input) {
      if (input.parentCode === input.code) {
        throw new BusinessRuleError(
          "Bir merkez kendi üstü olamaz; ağaç yürüyüşü sonsuz döngüye girer.",
          "self_parent",
        );
      }
      const res = await repo.createCenter(input);
      return {
        ok: true as const,
        data: { ...res, name: input.name, parentCode: input.parentCode },
        sources: [kaynak("Masraf merkezleri", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.code} masraf merkezi açıldı. Bu merkezin gideri, yevmiye ` +
              `satırına merkez kodu YAZILDIĞI andan itibaren birikir; geçmiş ` +
              `kayıtlar geriye dönük atanmaz.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const list = defineTool({
    name: "list_cost_centers",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Masraf merkezlerini listeler: kod, ad, üst merkez ve sorumlu. " +
        "'Departmanlarımız neler', 'masraf merkezleri' sorularında kullan.",
      en: "Lists cost centers with their tree structure.",
    },
    input: z.strictObject({
      includeInactive: z.boolean().describe("Kapatılmış merkezler de gelsin mi?"),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input) {
      const rows = await repo.centers(input.includeInactive);
      return {
        ok: true as const,
        data: {
          total: rows.length,
          centers: rows.map((c) => ({
            code: c.code,
            name: c.name,
            parentCode: c.parentCode,
            isActive: c.isActive,
            childCount: rows.filter((x) => x.parentCode === c.code).length,
          })),
        },
        sources: [kaynak("Masraf merkezleri", rows.length)],
        risks:
          rows.length === 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    "Hiç masraf merkezi tanımlı değil. Merkez olmadan gider bir " +
                    "departmana bağlanamaz ve bütçe takibi yapılamaz.",
                },
              ]
            : [],
        confidence: 98,
      };
    },
  });

  const setBudget = defineTool({
    name: "set_budget",
    module: "accounting",
    authority: 2,
    description: {
      tr:
        "Bir masraf merkezine dönem bütçesi girer: hesap GRUBU (üç hane, örn. " +
        "770), yıl ve isteğe bağlı ay. Ay verilmezse YILLIK bütçedir ve aylık " +
        "raporlarda 12'ye bölünmez — bölmek, mevsimsel bir gideri her ay aşmış " +
        "gösterirdi. Var olan bütçe güncellenir ve kim değiştirdiği kaydedilir.",
      en: "Sets a period budget for a cost center and account group.",
    },
    input: z.strictObject({
      costCenterCode: z.string().trim().min(1).max(30).describe("Masraf merkezi kodu."),
      accountGroup: z
        .string()
        .regex(/^[0-9]{3}$/)
        .describe("TDHP hesap grubu, üç hane. Örn. 770 Genel Yönetim Giderleri."),
      year: z.number().int().min(2000).max(2100).describe("Bütçe yılı."),
      month: z.number().int().min(1).max(12).nullable().describe("Ay (1-12); yıllık bütçe için null."),
      amount: z.number().min(0).describe("Bütçe tutarı. Sıfır olabilir ('bu merkeze harcama yok'); negatif olamaz."),
      currency: z.string().length(3).describe("Para birimi. Genelde TRY."),
      note: z.string().max(300).nullable().describe("Açıklama; yoksa null."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, ctx) {
      const res = await repo.setBudget({
        costCenterCode: input.costCenterCode,
        accountGroup: input.accountGroup,
        year: input.year,
        month: input.month,
        amount: input.amount,
        currency: input.currency.toUpperCase(),
        note: input.note,
        userId: ctx.principal.userId,
      });
      const donem = input.month === null ? `${input.year} yılı` : `${input.year}/${input.month}`;
      return {
        ok: true as const,
        data: { ...res, costCenterCode: input.costCenterCode, accountGroup: input.accountGroup, amount: input.amount },
        sources: [kaynak("Bütçeler", 1)],
        risks: [
          {
            severity: "info" as const,
            message: res.created
              ? `${input.costCenterCode} · ${input.accountGroup} · ${donem}: ` +
                `${TR.format(input.amount)} ${input.currency.toUpperCase()} bütçe girildi.`
              : `${input.costCenterCode} · ${input.accountGroup} · ${donem} bütçesi ` +
                `${TR.format(res.previous ?? 0)} → ${TR.format(input.amount)} olarak REVİZE edildi.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const variance = defineTool({
    name: "get_budget_vs_actual",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Bütçe–gerçekleşme karşılaştırması: hangi masraf merkezi bütçesini aştı, " +
        "ne kadar kaldı, hangisi aşmaya yakın. 'Bütçeyi aştık mı', 'hangi " +
        "departman ne harcadı', 'bütçe durumu', 'gider raporu' sorularında " +
        "kullan. Bir merkez verilirse ALTINDAKİ merkezler de toplanır. " +
        "Bütçesi girilmemiş gider 'aşım' sayılmaz, ayrıca bildirilir.",
      en: "Budget vs actual by cost center and account group.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Hangi yıl."),
      month: z.number().int().min(1).max(12).nullable().describe("Ay (1-12); yılın tamamı için null."),
      costCenterCode: z
        .string()
        .trim()
        .max(30)
        .nullable()
        .describe("Tek merkez (ve altı) için kod; tüm merkezler için null."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input) {
      const [merkezler, butceler, gercek] = await Promise.all([
        repo.centers(true),
        repo.budgets(input.year),
        repo.actuals(input.year),
      ]);

      let kapsam: readonly string[] | null = null;
      if (input.costCenterCode !== null) {
        if (!merkezler.some((m) => m.code === input.costCenterCode)) {
          throw new BusinessRuleError(
            `${input.costCenterCode} kodlu masraf merkezi yok.`,
            "cost_center_not_found",
          );
        }
        try {
          kapsam = descendantsOf(input.costCenterCode, merkezler);
        } catch (e) {
          if (e instanceof ControllingError) {
            throw new BusinessRuleError(e.message, "cost_center_cycle");
          }
          throw e;
        }
      }

      const suz = <T extends { costCenterCode: string }>(xs: readonly T[]) =>
        kapsam === null ? xs : xs.filter((x) => kapsam!.includes(x.costCenterCode));

      const rapor = budgetVsActual(
        input.year,
        input.month,
        merkezler,
        suz(butceler),
        suz(gercek.lines),
      );

      const riskler: { severity: "warning" | "info" | "critical"; message: string }[] = [];

      if (rapor.overCount > 0) {
        const asanlar = rapor.rows.filter((r) => r.status === "over");
        const toplamAsim = asanlar.reduce((s, r) => s + Math.abs(r.variance ?? 0), 0);
        riskler.push({
          severity: "critical",
          message:
            `${rapor.overCount} bütçe kalemi AŞILDI, toplam aşım ` +
            `${TR.format(toplamAsim)} ₺. En büyüğü: ${asanlar[0]!.costCenterName} · ` +
            `${asanlar[0]!.accountGroup} (${TR.format(Math.abs(asanlar[0]!.variance ?? 0))} ₺).`,
        });
      }
      const izleme = rapor.rows.filter((r) => r.status === "watch");
      if (izleme.length > 0) {
        riskler.push({
          severity: "warning",
          message: `${izleme.length} kalem bütçesinin %90'ını geçti; henüz aşmadı ama yaklaşıyor.`,
        });
      }
      if (rapor.unbudgetedCount > 0) {
        riskler.push({
          severity: "warning",
          message:
            `${rapor.unbudgetedCount} merkez-grup çiftinde harcama var ama BÜTÇE ` +
            `GİRİLMEMİŞ (${TR.format(rapor.unbudgetedAmount)} ₺). Bunlar "aşım" ` +
            `sayılmadı — bütçesiz harcama, aşan harcamadan farklı bir eksikliktir.`,
        });
      }
      if (gercek.unassigned.count > 0) {
        riskler.push({
          severity: "warning",
          message:
            `${gercek.unassigned.count} gider satırında masraf merkezi YOK ` +
            `(${TR.format(gercek.unassigned.amount)} ₺) ve rapora girmedi. Bunlar ` +
            `bir merkeze dağıtılmadı çünkü dağıtmak uydurma olurdu; kaydı atan ` +
            `kişi merkez yazmalı.`,
        });
      }

      return {
        ok: true as const,
        data: { ...rapor, scope: input.costCenterCode, unassigned: gercek.unassigned },
        sources: [
          kaynak("Bütçeler", butceler.length),
          kaynak("Yevmiye defteri", gercek.lines.length),
        ],
        risks: riskler,
        // Atanmamış gider varsa rapor eksiktir ve güven bunu yansıtmalı.
        confidence: gercek.unassigned.count > 0 ? 72 : 94,
      };
    },
  });

  return [create, list, setBudget, variance] as const;
}
