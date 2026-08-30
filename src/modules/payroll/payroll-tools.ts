/**
 * Bordro tool'ları.
 *
 * BORDRO ÇALIŞTIRMAK L3'TÜR. İşletmenin en büyük ikinci gider
 * kalemini tahakkuk ettirir, SGK'ya bildirilecek tutarları belirler ve
 * geri alınamaz: çalıştırılmış bordro değiştirilemez, düzeltme ek
 * bordro ister. Fatura kesmekle aynı ağırlıktadır.
 *
 * BORDRO OKUMAK DA HERKESE AÇIK DEĞİLDİR. Maaş bilgisi, sistemdeki en
 * hassas veridir; depo sorumlusunun görmesi gereken bir şey değildir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { PayrollRepository } from "../../db/payroll-repository.js";
import { annualPlan, calculate } from "./payroll.js";
import { parametersFor } from "./parameters.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });
const money = (n: number): string => `${TR.format(n)} TL`;

export function payrollTools(repo: PayrollRepository) {
  /*
   * TEK AY VE YILLIK AYRI TOOL'LARDIR.
   *
   * Tek tool'a `annual: boolean` koymak, aynı tool'un iki farklı
   * biçimde veri döndürmesi demekti; modele belirsiz bir sözleşme
   * sunar ve tip sistemi de bunu kabul etmez. İki tool, iki net
   * cevap.
   */
  const simulate = defineTool({
    name: "simulate_payroll",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir brüt ücretin NET karşılığını ve İŞVERENE MALİYETİNİ hesaplar — hiçbir " +
        "kayıt yazmaz. SGK primi, gelir vergisi (kümülatif matrah üzerinden), damga " +
        "vergisi ve asgari ücret istisnası uygulanır. 'Bu maaş kaça mal olur', " +
        "'brüt 100 bin ne kadar net eder' sorularında kullan. Yılın tamamı için " +
        "plan_annual_payroll kullanılır.",
      en: "Simulates one month's net salary and employer cost; writes nothing.",
    },
    input: z.strictObject({
      grossSalary: z.number().describe("Brüt aylık ücret."),
      period: z.string().describe("Bordro dönemi (ISO 8601)."),
      cumulativeBase: z
        .number()
        .describe("Bu aydan önceki kümülatif gelir vergisi matrahı; yılın ilk ayında 0."),
    }),
    requires: ["hr:payroll.read"],
    async execute(input, _ctx) {
      const r = calculate({
        grossSalary: input.grossSalary,
        period: new Date(input.period),
        cumulativeBase: input.cumulativeBase,
      });
      return {
        ok: true as const,
        data: {
          grossSalary: r.grossSalary,
          totalGross: r.totalGross,
          sgkBase: r.sgkBase,
          employeeSgk: r.employeeSgk,
          employeeUnemployment: r.employeeUnemployment,
          taxBase: r.taxBase,
          grossIncomeTax: r.grossIncomeTax,
          incomeTaxExemption: r.incomeTaxExemption,
          incomeTax: r.incomeTax,
          stampDuty: r.stampDuty,
          totalDeductions: r.totalDeductions,
          netSalary: r.netSalary,
          employerSgk: r.employerSgk,
          employerUnemployment: r.employerUnemployment,
          employerCost: r.employerCost,
          marginalRate: r.marginalRate,
          parameterYear: r.parameters.year,
          summary:
            `Brüt ${money(r.totalGross)} → net ${money(r.netSalary)}. İşverene ` +
            `maliyeti ${money(r.employerCost)} (vergi dilimi %${r.marginalRate}).`,
        },
        sources: [
          {
            system: "Bordro parametreleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: r.caveats.map((c) => ({ severity: "info" as const, message: c })),
        confidence: 92,
      };
    },
  });

  const annual = defineTool({
    name: "plan_annual_payroll",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir brüt ücretin 12 AYLIK planını çıkarır: kümülatif matrah büyüdükçe vergi " +
        "dilimi yükselir, NET MAAŞ YIL İÇİNDE DÜŞER ve işveren maliyeti sabit kalır. " +
        "'Bu çalışan bana yılda kaça mal olur', 'zam sonrası yıllık maliyet' " +
        "sorularında kullan. TEK AYIN 12 KATI YANLIŞ CEVAPTIR.",
      en: "Produces a 12-month payroll plan showing bracket progression.",
    },
    input: z.strictObject({
      grossSalary: z.number().describe("Brüt aylık ücret."),
      year: z.number().int().describe("Hangi yıl."),
    }),
    requires: ["hr:payroll.read"],
    async execute(input, _ctx) {
      const plan = annualPlan(input.grossSalary, input.year);
      const totalNet = plan.reduce((s, r) => s + r.netSalary, 0);
      const totalCost = plan.reduce((s, r) => s + r.employerCost, 0);
      const first = plan[0]!;
      const last = plan[11]!;
      return {
        ok: true as const,
        data: {
          months: plan.map((r, i) => ({
            month: i + 1,
            gross: r.totalGross,
            incomeTax: r.incomeTax,
            net: r.netSalary,
            marginalRate: r.marginalRate,
            employerCost: r.employerCost,
          })),
          annualNet: Math.round(totalNet * 100) / 100,
          annualEmployerCost: Math.round(totalCost * 100) / 100,
          summary:
            `Brüt ${money(input.grossSalary)}: ocak neti ${money(first.netSalary)}, ` +
            `aralık neti ${money(last.netSalary)} (vergi dilimi %${first.marginalRate} → ` +
            `%${last.marginalRate}). Yıllık işveren maliyeti ${money(totalCost)}.`,
        },
        sources: [
          {
            system: "Bordro parametreleri",
            kind: "module" as const,
            recordCount: 12,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: first.caveats.map((c) => ({ severity: "info" as const, message: c })),
        confidence: 92,
      };
    },
  });

  const payslip = defineTool({
    name: "get_payslip",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir çalışanın belirli bir dönemdeki BORDRO PUSULASINI getirir: brüt, SGK " +
        "kesintileri, gelir vergisi (istisna dahil), damga vergisi, net ve işveren " +
        "maliyeti. 'Maaş pusulası', 'bordromu göster' sorularında kullan.",
      en: "Returns an employee's payslip for a period.",
    },
    input: z.strictObject({
      employeeCode: z.string().min(1).max(64).describe("Personel kodu."),
      period: z.string().describe("Bordro dönemi (ISO 8601)."),
    }),
    requires: ["hr:payroll.read"],
    async execute(input, _ctx) {
      const p = await repo.payslip(input.employeeCode, new Date(input.period));
      if (!p) {
        return {
          ok: true as const,
          data: null,
          sources: [
            {
              system: "Bordro",
              kind: "module" as const,
              recordCount: 0,
              syncedAt: new Date().toISOString(),
            },
          ],
          risks: [
            {
              severity: "warning" as const,
              message:
                `${input.employeeCode} için ${input.period.slice(0, 7)} dönemi bordrosu ` +
                `bulunamadı; bordro henüz çalıştırılmamış olabilir.`,
            },
          ],
          confidence: 90,
        };
      }
      return {
        ok: true as const,
        data: {
          kind: "payslip" as const,
          payslip: p,
          summary:
            `${p.employeeName}, ${p.period.slice(0, 7)}: brüt ${money(p.totalGross)}, ` +
            `net ${money(p.netSalary)}.`,
        },
        sources: [
          {
            system: "Bordro",
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

  const summary = defineTool({
    name: "get_payroll_summary",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir dönemin bordro özeti: kaç çalışan, toplam brüt, toplam net ve TOPLAM " +
        "İŞVEREN MALİYETİ, çalışan kırılımıyla. 'Bu ay maaşlar ne kadar tuttu', " +
        "'personel maliyeti' sorularında kullan.",
      en: "Payroll summary for a period with per-employee breakdown.",
    },
    input: z.strictObject({
      period: z.string().describe("Bordro dönemi (ISO 8601)."),
    }),
    requires: ["hr:payroll.read"],
    async execute(input, _ctx) {
      const s = await repo.summary(new Date(input.period));
      if (!s) {
        return {
          ok: true as const,
          data: null,
          sources: [
            {
              system: "Bordro",
              kind: "module" as const,
              recordCount: 0,
              syncedAt: new Date().toISOString(),
            },
          ],
          risks: [
            {
              severity: "warning" as const,
              message: `${input.period.slice(0, 7)} dönemi bordrosu henüz çalıştırılmamış.`,
            },
          ],
          confidence: 90,
        };
      }
      return {
        ok: true as const,
        data: {
          ...s,
          summary:
            `${s.employeeCount} çalışan, toplam brüt ${money(s.totalGross)}, net ` +
            `${money(s.totalNet)}, işverene maliyet ${money(s.totalEmployerCost)}.`,
        },
        sources: [
          {
            system: "Bordro",
            kind: "module" as const,
            recordCount: s.employees.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 97,
      };
    },
  });

  const run = defineTool({
    name: "run_payroll",
    module: "hr",
    authority: 3,
    confirm: "always",
    description: {
      tr:
        "Bir dönemin bordrosunu ÇALIŞTIRIR ve muhasebe kaydını yazar: personel gideri " +
        "borçlanır; çalışana, SGK'ya ve vergi dairesine borç alacaklanır. Kümülatif " +
        "vergi matrahı her çalışan için yıl başından itibaren yürütülür. AYNI DÖNEM " +
        "İKİ KEZ ÇALIŞTIRILAMAZ ve çalıştırılmış bordro DEĞİŞTİRİLEMEZ; düzeltme ek " +
        "bordro ister. Ücreti tanımsız çalışan atlanır, sıfırla hesaplanmaz.",
      en: "Runs payroll for a period and posts the accrual journal entry.",
    },
    input: z.strictObject({
      period: z.string().describe("Bordro dönemi (ISO 8601); ayın herhangi bir günü."),
    }),
    requires: ["hr:payroll.run"],
    async execute(input, ctx) {
      const r = await repo.run({ period: new Date(input.period), userId: ctx.principal.userId });
      return {
        ok: true as const,
        data: {
          ...r,
          summary:
            `${r.period.slice(0, 7)} bordrosu: ${r.employeeCount} çalışan, net ödenecek ` +
            `${money(r.totalNet)}, işverene maliyet ${money(r.totalEmployerCost)} ` +
            `(${r.documentNo}).`,
        },
        sources: [
          {
            system: "Bordro",
            kind: "module" as const,
            recordCount: r.employeeCount,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          // ATLANANLAR SESSİZ KALMAZ: "hepsini ödedim" sanıp bir
          // çalışanı maaşsız bırakmak, düzeltmesi en pahalı hatadır.
          ...(r.skipped.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${r.skipped.length} çalışan bordroya ALINMADI: ` +
                    r.skipped.map((s) => `${s.code} (${s.reason})`).join(", ") +
                    ". Bu kişiler bu ay maaş almayacak.",
                },
              ]
            : []),
          ...r.caveats.map((c) => ({ severity: "warning" as const, message: c })),
        ],
        confidence: 94,
      };
    },
  });

  const parameters = defineTool({
    name: "get_payroll_parameters",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir yılın bordro parametrelerini ve KAYNAKLARINI gösterir: asgari ücret, SGK " +
        "taban/tavan, prim oranları, gelir vergisi dilimleri, damga vergisi oranı ve " +
        "kıdem tavanı. Her parametrenin kaynağı ve TEYİT DURUMU görünür — teyide " +
        "muhtaç bir oran varsa hesaplar onunla yapılır ama çekince ile bildirilir.",
      en: "Shows a year's payroll parameters with their sources and confidence.",
    },
    input: z.strictObject({
      year: z.number().int().describe("Hangi yıl."),
    }),
    requires: ["hr:payroll.read"],
    async execute(input, _ctx) {
      const p = parametersFor(new Date(Date.UTC(input.year, 5, 15)));
      const fmt = <T,>(x: { value: T; source: string; confidence: string }) => ({
        value: x.value,
        source: x.source,
        confidence: x.confidence,
      });
      return {
        ok: true as const,
        data: {
          year: p.year,
          validFrom: p.validFrom,
          minimumWage: fmt(p.minimumWage),
          sgkFloor: fmt(p.sgkFloor),
          sgkCeiling: fmt(p.sgkCeiling),
          employeeSgkRate: fmt(p.employeeSgkRate),
          employeeUnemploymentRate: fmt(p.employeeUnemploymentRate),
          employerSgkRate: fmt(p.employerSgkRate),
          employerUnemploymentRate: fmt(p.employerUnemploymentRate),
          stampDutyRate: fmt(p.stampDutyRate),
          brackets: fmt(p.brackets),
          severanceCap: fmt(p.severanceCap),
          summary:
            `${p.year}: brüt asgari ücret ${money(p.minimumWage.value)}, SGK tavanı ` +
            `${money(p.sgkCeiling.value)}, ilk vergi dilimi ${money(190_000)} (%15).`,
        },
        sources: [
          {
            system: "Mevzuat parametreleri",
            kind: "module" as const,
            recordCount: 10,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 95,
      };
    },
  });

  return [simulate, annual, payslip, summary, run, parameters] as const;
}
