/**
 * Bordro kalıcılığı.
 *
 * BORDRO ÇALIŞTIRMAK MUHASEBE KAYDI YAZAR. Yalnızca tutarları
 * hesaplamak yetmez: ücret gideri borçlanır, çalışana borç, SGK'ya
 * borç ve vergi dairesine borç alacaklanır. Kayıt yazılmazsa bilanço
 * ödenecek maaşı hiç görmez ve "bu ay ne kadar borcumuz var"
 * sorusunun cevabı eksik çıkar.
 *
 * KÜMÜLATİF MATRAH SAKLANANDAN OKUNUR, YENİDEN HESAPLANMAZ. Geçmiş
 * ayların bordrosu yeniden hesaplansaydı, bugün yapılan bir düzeltme
 * geçmiş vergiyi değiştirir ve SGK'ya bildirilmiş tutarla ayrışırdı.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { JournalRepository } from "./journal-repository.js";
import { calculate, type PayrollResult } from "../modules/payroll/payroll.js";
import { parametersFor } from "../modules/payroll/parameters.js";

export class PayrollRepositoryError extends Error {
  readonly code = "payroll_run";
  constructor(message: string) {
    super(message);
    this.name = "PayrollRepositoryError";
  }
}

export interface PayslipView {
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly department: string;
  readonly position: string;
  readonly period: string;
  readonly grossSalary: number;
  readonly bonus: number;
  readonly totalGross: number;
  readonly sgkBase: number;
  readonly employeeSgk: number;
  readonly employeeUnemployment: number;
  readonly taxBase: number;
  readonly cumulativeBefore: number;
  readonly cumulativeAfter: number;
  readonly grossIncomeTax: number;
  readonly incomeTaxExemption: number;
  readonly incomeTax: number;
  readonly stampDuty: number;
  readonly totalDeductions: number;
  readonly netSalary: number;
  readonly employerSgk: number;
  readonly employerUnemployment: number;
  readonly employerCost: number;
}

const num = (v: unknown): number => Number(v ?? 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Dönemi ayın ilk gününe indirger. */
function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export class PayrollRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Bir çalışanın belirli bir dönemden ÖNCEKİ kümülatif matrahı.
   *
   * AYNI YILIN ÖNCEKİ AYLARINDAN toplanır. Yıl dönümünde sıfırlanır:
   * gelir vergisi tarifesi takvim yılı bazlıdır ve devrolsaydı ikinci
   * yılın ocak ayında çalışan en üst dilimden vergilendirilirdi.
   */
  async cumulativeBefore(employeeId: string, period: Date): Promise<number> {
    const p = monthStart(period);
    const yearStart = new Date(Date.UTC(p.getUTCFullYear(), 0, 1));
    const agg = await this.#db.payrollLine.aggregate({
      where: { employeeId, period: { gte: yearStart, lt: p } },
      _sum: { taxBase: true },
    });
    return round2(num(agg._sum.taxBase));
  }

  async payslip(employeeCode: string, period: Date): Promise<PayslipView | null> {
    const emp = await this.#db.employee.findUnique({ where: { code: employeeCode } });
    if (!emp) return null;
    const line = await this.#db.payrollLine.findUnique({
      where: { period_employeeId: { period: monthStart(period), employeeId: emp.id } },
    });
    if (!line) return null;
    return {
      employeeCode: emp.code,
      employeeName: emp.fullName,
      department: emp.department,
      position: emp.position,
      period: line.period.toISOString().slice(0, 10),
      grossSalary: num(line.grossSalary),
      bonus: num(line.bonus),
      totalGross: num(line.totalGross),
      sgkBase: num(line.sgkBase),
      employeeSgk: num(line.employeeSgk),
      employeeUnemployment: num(line.employeeUnemployment),
      taxBase: num(line.taxBase),
      cumulativeBefore: num(line.cumulativeBefore),
      cumulativeAfter: num(line.cumulativeAfter),
      grossIncomeTax: num(line.grossIncomeTax),
      incomeTaxExemption: num(line.incomeTaxExemption),
      incomeTax: num(line.incomeTax),
      stampDuty: num(line.stampDuty),
      totalDeductions: num(line.totalDeductions),
      netSalary: num(line.netSalary),
      employerSgk: num(line.employerSgk),
      employerUnemployment: num(line.employerUnemployment),
      employerCost: num(line.employerCost),
    };
  }

  /**
   * Bir dönemin bordrosunu çalıştırır.
   *
   * TEK İŞLEM: bordro satırları ve yevmiye kaydı birlikte yazılır.
   * Biri yazılıp diğeri yazılmasaydı, ödenecek maaş ile deftere geçen
   * borç birbirini tutmazdı.
   */
  async run(input: {
    period: Date;
    userId: string;
    /** Çalışan bazında ek kazanç (prim/ikramiye). */
    bonuses?: Readonly<Record<string, number>>;
  }): Promise<{
    period: string;
    employeeCount: number;
    totalGross: number;
    totalNet: number;
    totalEmployerCost: number;
    documentNo: string | null;
    skipped: readonly { code: string; reason: string }[];
    caveats: readonly string[];
    lines: readonly { code: string; name: string; gross: number; net: number }[];
  }> {
    const period = monthStart(input.period);

    const existing = await this.#db.payrollRun.findUnique({ where: { period } });
    if (existing) {
      throw new PayrollRepositoryError(
        `${period.toISOString().slice(0, 7)} dönemi bordrosu zaten çalıştırıldı ` +
          `(${existing.employeeCount} çalışan). Aynı dönem iki kez çalıştırılamaz; ` +
          `düzeltme için ek bordro düzenlenir.`,
      );
    }

    // Parametreler yoksa hiç başlanmaz: yarım bordro, hiç bordrodan kötüdür.
    const params = parametersFor(period);

    const employees = await this.#db.employee.findMany({
      where: {
        isActive: true,
        // DÖNEMDEN SONRA İŞE GİRENİ KAPSAMA ALMAZ.
        hiredAt: { lte: new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 0)) },
        OR: [{ terminatedAt: null }, { terminatedAt: { gte: period } }],
      },
      orderBy: { code: "asc" },
    });

    if (employees.length === 0) {
      throw new PayrollRepositoryError("Bu dönemde bordroya girecek aktif çalışan yok.");
    }

    const skipped: { code: string; reason: string }[] = [];
    const computed: { employeeId: string; code: string; name: string; r: PayrollResult }[] = [];
    const caveats = new Set<string>();

    for (const e of employees) {
      const gross = num(e.grossSalary);
      // ÜCRETİ TANIMSIZ ÇALIŞAN ATLANIR, SIFIRLA HESAPLANMAZ. Sıfır
      // ücretli bir bordro satırı, SGK'ya sıfır kazanç bildirmek demektir.
      if (!e.grossSalary || gross <= 0) {
        skipped.push({ code: e.code, reason: "brüt ücreti tanımlı değil" });
        continue;
      }
      const before = await this.cumulativeBefore(e.id, period);
      const r = calculate({
        grossSalary: gross,
        period,
        cumulativeBase: before,
        bonus: input.bonuses?.[e.code] ?? 0,
      });
      for (const c of r.caveats) caveats.add(c);
      computed.push({ employeeId: e.id, code: e.code, name: e.fullName, r });
    }

    if (computed.length === 0) {
      throw new PayrollRepositoryError(
        `Hiçbir çalışan bordroya alınamadı: ${skipped.map((s) => `${s.code} (${s.reason})`).join(", ")}`,
      );
    }

    const totalGross = round2(computed.reduce((s, c) => s + c.r.totalGross, 0));
    const totalNet = round2(computed.reduce((s, c) => s + c.r.netSalary, 0));
    const totalEmployerCost = round2(computed.reduce((s, c) => s + c.r.employerCost, 0));
    const totalSgkEmployee = round2(
      computed.reduce((s, c) => s + c.r.employeeSgk + c.r.employeeUnemployment, 0),
    );
    const totalSgkEmployer = round2(
      computed.reduce((s, c) => s + c.r.employerSgk + c.r.employerUnemployment, 0),
    );
    const totalIncomeTax = round2(computed.reduce((s, c) => s + c.r.incomeTax, 0));
    const totalStamp = round2(computed.reduce((s, c) => s + c.r.stampDuty, 0));

    return this.#db.$transaction(async (tx) => {
      /*
       * ── MUHASEBE KAYDI ──
       *
       * 770 Genel Yönetim Giderleri  → brüt ücret + işveren SGK payı
       * 335 Personele Borçlar        → net ödenecek
       * 360 Ödenecek Vergi ve Fonlar → gelir + damga vergisi
       * 361 Ödenecek SGK Kesintileri → işçi + işveren SGK payı
       *
       * İŞVEREN PAYI DA GİDERDİR. Yalnızca brüt gider yazılsaydı
       * personel maliyeti gerçeğin beşte bir altında görünürdü.
       */
      const lines = [
        {
          accountCode: "770",
          debit: round2(totalGross + totalSgkEmployer),
          credit: 0,
          description: `${period.toISOString().slice(0, 7)} dönemi personel gideri`,
        },
        {
          accountCode: "335",
          debit: 0,
          credit: totalNet,
          description: "Personele ödenecek net ücret",
        },
        {
          accountCode: "360",
          debit: 0,
          credit: round2(totalIncomeTax + totalStamp),
          description: "Ödenecek gelir ve damga vergisi",
        },
        {
          accountCode: "361",
          debit: 0,
          credit: round2(totalSgkEmployee + totalSgkEmployer),
          description: "Ödenecek SGK kesintileri",
        },
      ].filter((l) => l.debit > 0 || l.credit > 0);

      const entry = await JournalRepository.postIn(tx, {
        // Bordro AY SONUNDA tahakkuk eder.
        entryDate: new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 0)),
        description: `${period.toISOString().slice(0, 7)} dönemi bordrosu (${computed.length} çalışan)`,
        sourceKind: "manual",
        userId: input.userId,
        lines,
      });

      const run = await tx.payrollRun.create({
        data: {
          period,
          status: "posted",
          employeeCount: computed.length,
          totalGross: new Prisma.Decimal(totalGross),
          totalNet: new Prisma.Decimal(totalNet),
          totalEmployerCost: new Prisma.Decimal(totalEmployerCost),
          journalDocumentNo: entry.documentNo,
          parameterYear: params.year,
          runBy: input.userId,
        },
      });

      for (const c of computed) {
        const r = c.r;
        await tx.payrollLine.create({
          data: {
            runId: run.id,
            employeeId: c.employeeId,
            period,
            grossSalary: new Prisma.Decimal(r.grossSalary),
            bonus: new Prisma.Decimal(r.bonus),
            totalGross: new Prisma.Decimal(r.totalGross),
            sgkBase: new Prisma.Decimal(r.sgkBase),
            employeeSgk: new Prisma.Decimal(r.employeeSgk),
            employeeUnemployment: new Prisma.Decimal(r.employeeUnemployment),
            taxBase: new Prisma.Decimal(r.taxBase),
            cumulativeBefore: new Prisma.Decimal(r.cumulativeBaseBefore),
            cumulativeAfter: new Prisma.Decimal(r.cumulativeBaseAfter),
            grossIncomeTax: new Prisma.Decimal(r.grossIncomeTax),
            incomeTaxExemption: new Prisma.Decimal(r.incomeTaxExemption),
            incomeTax: new Prisma.Decimal(r.incomeTax),
            stampDuty: new Prisma.Decimal(r.stampDuty),
            totalDeductions: new Prisma.Decimal(r.totalDeductions),
            netSalary: new Prisma.Decimal(r.netSalary),
            employerSgk: new Prisma.Decimal(r.employerSgk),
            employerUnemployment: new Prisma.Decimal(r.employerUnemployment),
            employerCost: new Prisma.Decimal(r.employerCost),
          },
        });
      }

      return {
        period: period.toISOString().slice(0, 10),
        employeeCount: computed.length,
        totalGross,
        totalNet,
        totalEmployerCost,
        documentNo: entry.documentNo,
        skipped,
        caveats: [...caveats],
        lines: computed.map((c) => ({
          code: c.code,
          name: c.name,
          gross: c.r.totalGross,
          net: c.r.netSalary,
        })),
      };
    });
  }

  /** Bir dönemin bordro özeti. */
  async summary(period: Date) {
    const p = monthStart(period);
    const run = await this.#db.payrollRun.findUnique({
      where: { period: p },
      include: { lines: { include: { employee: { select: { code: true, fullName: true, department: true } } } } },
    });
    if (!run) return null;
    return {
      period: p.toISOString().slice(0, 10),
      employeeCount: run.employeeCount,
      totalGross: num(run.totalGross),
      totalNet: num(run.totalNet),
      totalEmployerCost: num(run.totalEmployerCost),
      documentNo: run.journalDocumentNo,
      parameterYear: run.parameterYear,
      employees: run.lines.map((l) => ({
        code: l.employee.code,
        name: l.employee.fullName,
        department: l.employee.department,
        gross: num(l.totalGross),
        deductions: num(l.totalDeductions),
        net: num(l.netSalary),
        employerCost: num(l.employerCost),
      })),
    };
  }
}
