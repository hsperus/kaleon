/**
 * İzin ve vardiya deposu.
 *
 * İZİN HAKKI HER SORULDUĞUNDA YENİDEN HESAPLANIR. Saklansaydı, kıdem
 * yılı dolduğunda kimse güncellemeyi hatırlamaz ve çalışan eski hakkıyla
 * kalırdı — hem de sistem "hesapladı" göründüğü için kimse şüphelenmezdi.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import {
  annualEntitlement,
  assertApprover,
  assertRequestable,
  balance,
  deductsFromAnnual,
  workingDaysBetween,
  LeaveError,
  type LeaveBalance,
  type LeaveStatus,
  type LeaveType,
} from "../modules/hr/leave.js";
import { validateShift, weeklyOvertime, ShiftError } from "../modules/hr/shift.js";
import {
  draftTermination,
  type TerminationDraft,
  type TerminationReason,
} from "../modules/hr/termination.js";

export interface LeaveRequestView {
  readonly id: string;
  readonly employeeCode: string;
  readonly type: LeaveType;
  readonly startDate: string;
  readonly endDate: string;
  readonly workingDays: number;
  readonly status: LeaveStatus;
}

export class LeaveRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /** Yıllık izin bakiyesi — kanundan hesaplanır, tablodan okunmaz. */
  async balanceOf(employeeCode: string, on: Date): Promise<LeaveBalance & { employeeCode: string }> {
    const emp = await this.#db.employee.findUnique({ where: { code: employeeCode } });
    if (!emp) throw new LeaveError(`Personel bulunamadı: ${employeeCode}`);
    const entitlement = annualEntitlement({
      hiredAt: emp.hiredAt,
      on,
      birthDate: emp.birthDate ?? null,
    });

    const year = on.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

    const rows = await this.#db.leaveRequest.findMany({
      where: {
        employeeId: emp.id,
        type: "yillik",
        status: { in: ["approved", "submitted"] },
        startDate: { gte: yearStart, lt: yearEnd },
      },
      select: { status: true, workingDays: true },
    });

    let used = 0;
    let pending = 0;
    for (const r of rows) {
      if (r.status === "approved") used += Number(r.workingDays);
      else pending += Number(r.workingDays);
    }

    const adjustments = await this.#db.leaveAdjustment.aggregate({
      where: { employeeId: emp.id, year },
      _sum: { days: true },
    });

    return {
      employeeCode,
      ...balance({
        entitlement,
        usedDays: used,
        pendingDays: pending,
        carriedOver: Number(adjustments._sum.days ?? 0),
      }),
    };
  }

  async request(input: {
    employeeCode: string;
    type: LeaveType;
    startDate: Date;
    endDate: Date;
    reason?: string | null;
    requestedBy: string;
    holidays?: readonly Date[];
    weekendDays?: readonly number[];
  }): Promise<LeaveRequestView> {
    const emp = await this.#db.employee.findUnique({ where: { code: input.employeeCode } });
    if (!emp) throw new LeaveError(`Personel bulunamadı: ${input.employeeCode}`);

    const days = workingDaysBetween(
      input.startDate,
      input.endDate,
      input.holidays ?? [],
      input.weekendDays ?? [0],
    );

    // ÇAKIŞMA KONTROLÜ İPTAL EDİLMEMİŞ TALEPLERE BAKAR: reddedilmiş veya
    // iptal edilmiş bir izin, yeni talebi engellememelidir.
    const overlapping = await this.#db.leaveRequest.findMany({
      where: {
        employeeId: emp.id,
        status: { in: ["approved", "submitted"] },
        startDate: { lte: input.endDate },
        endDate: { gte: input.startDate },
      },
      select: { startDate: true, endDate: true },
    });

    const bal = deductsFromAnnual(input.type)
      ? await this.balanceOf(input.employeeCode, input.startDate)
      : { entitled: 0, used: 0, pending: 0, remaining: 0, basis: "" };

    assertRequestable({
      type: input.type,
      days,
      balance: bal,
      overlapping: overlapping.map((o) => ({
        from: o.startDate.toISOString().slice(0, 10),
        to: o.endDate.toISOString().slice(0, 10),
      })),
    });

    const row = await this.#db.leaveRequest.create({
      data: {
        employeeId: emp.id,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        workingDays: new Prisma.Decimal(days),
        reason: input.reason ?? null,
        requestedBy: input.requestedBy,
        status: "submitted",
      },
    });

    return {
      id: row.id,
      employeeCode: input.employeeCode,
      type: input.type,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate.toISOString().slice(0, 10),
      workingDays: days,
      status: "submitted",
    };
  }

  async approve(id: string, approverId: string): Promise<void> {
    const row = await this.#db.leaveRequest.findUnique({ where: { id } });
    if (!row) throw new LeaveError("İzin talebi bulunamadı.");
    if (row.status !== "submitted") {
      throw new LeaveError(`Talep ${row.status} durumunda; onaylanamaz.`);
    }
    assertApprover(row.requestedBy, approverId);

    await this.#db.leaveRequest.update({
      where: { id },
      data: { status: "approved", approvedBy: approverId, approvedAt: new Date() },
    });
  }

  async reject(id: string, approverId: string, reason: string): Promise<void> {
    if (reason.trim().length < 5) {
      throw new LeaveError("Ret sebebi yazılmalıdır.");
    }
    const row = await this.#db.leaveRequest.findUnique({ where: { id } });
    if (!row) throw new LeaveError("İzin talebi bulunamadı.");
    assertApprover(row.requestedBy, approverId);
    await this.#db.leaveRequest.update({
      where: { id },
      data: { status: "rejected", rejectionReason: reason },
    });
  }

  async listFor(employeeCode: string, year: number): Promise<readonly LeaveRequestView[]> {
    const emp = await this.#db.employee.findUnique({ where: { code: employeeCode } });
    if (!emp) throw new LeaveError(`Personel bulunamadı: ${employeeCode}`);
    const rows = await this.#db.leaveRequest.findMany({
      where: {
        employeeId: emp.id,
        startDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
      },
      orderBy: { startDate: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      employeeCode,
      type: r.type as LeaveType,
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10),
      workingDays: Number(r.workingDays),
      status: r.status as LeaveStatus,
    }));
  }

  // ─── Vardiya ───

  async defineShift(input: {
    code: string;
    name: string;
    startsAt: string;
    endsAt: string;
    breakMinutes: number;
    isNight: boolean;
  }): Promise<{ hours: number; warnings: readonly string[] }> {
    // KANUNÎ SINIRLAR TANIMDA KONTROL EDİLİR. Puantajda yakalanırsa iş
    // zaten olmuştur ve geriye dönük düzeltilemez.
    const validated = validateShift(input);

    await this.#db.shift.upsert({
      where: { code: input.code },
      create: { ...input },
      update: {
        name: input.name,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        breakMinutes: input.breakMinutes,
        isNight: input.isNight,
      },
    });

    return validated;
  }

  /**
   * Vardiya atar.
   *
   * ONAYLI İZİNDEKİ KİŞİYE VARDİYA ATANMAZ. Atanırsa puantaj o günü
   * çalışılmış sayar ve izin bakiyesi ile mesai birbirini tutmaz.
   */
  async assignShift(input: {
    employeeCode: string;
    shiftCode: string;
    workDate: Date;
  }): Promise<void> {
    const [emp, shift] = await Promise.all([
      this.#db.employee.findUnique({ where: { code: input.employeeCode } }),
      this.#db.shift.findUnique({ where: { code: input.shiftCode } }),
    ]);
    if (!emp) throw new ShiftError(`Personel bulunamadı: ${input.employeeCode}`);
    if (!shift) throw new ShiftError(`Vardiya bulunamadı: ${input.shiftCode}`);

    const onLeave = await this.#db.leaveRequest.findFirst({
      where: {
        employeeId: emp.id,
        status: "approved",
        startDate: { lte: input.workDate },
        endDate: { gte: input.workDate },
      },
    });
    if (onLeave) {
      throw new ShiftError(
        `${input.employeeCode} ${input.workDate.toISOString().slice(0, 10)} tarihinde ` +
          `onaylı izinde (${onLeave.type}); vardiya atanamaz.`,
      );
    }

    await this.#db.shiftAssignment.upsert({
      where: { employeeId_workDate: { employeeId: emp.id, workDate: input.workDate } },
      create: { employeeId: emp.id, shiftId: shift.id, workDate: input.workDate },
      update: { shiftId: shift.id },
    });
  }

  /** Bir haftanın planlanan çalışma saatleri ve mesai aşımı. */
  async weeklyPlan(employeeCode: string, weekStart: Date) {
    const emp = await this.#db.employee.findUnique({ where: { code: employeeCode } });
    if (!emp) throw new ShiftError(`Personel bulunamadı: ${employeeCode}`);

    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    const rows = await this.#db.shiftAssignment.findMany({
      where: { employeeId: emp.id, workDate: { gte: weekStart, lt: weekEnd } },
      include: { shift: true },
      orderBy: { workDate: "asc" },
    });

    let total = 0;
    const days = rows.map((r) => {
      const hours = validateShift({
        code: r.shift.code,
        name: r.shift.name,
        startsAt: r.shift.startsAt,
        endsAt: r.shift.endsAt,
        breakMinutes: r.shift.breakMinutes,
        isNight: r.shift.isNight,
      }).hours;
      total += hours;
      return {
        workDate: r.workDate.toISOString().slice(0, 10),
        shiftCode: r.shift.code,
        hours,
      };
    });

    return {
      employeeCode,
      weekStart: weekStart.toISOString().slice(0, 10),
      days,
      totalHours: Math.round(total * 100) / 100,
      ...weeklyOvertime(total),
    };
  }

  // ─── İşten çıkış ───

  /**
   * İşten çıkış taslağı: kıdem, ihbar ve kullanılmayan izin.
   *
   * TASLAKTIR VE ÖYLE KALIR. Eksik ödenen kıdem tazminatı faiziyle dava
   * konusudur, fazla ödenen geri alınamaz; hesabı İK ve mali müşavir
   * onaylar. Anayasa: personel işlemleri asla otomatik tamamlanamaz.
   */
  async terminationDraft(input: {
    employeeCode: string;
    terminatedAt: Date;
    reason: TerminationReason;
    /** Giydirilmiş brüt günlük ücret; verilmezse aylık brütten türetilir. */
    dailyGrossWage?: number | null;
    severanceCeilingPerYear?: number | null;
  }): Promise<TerminationDraft & { employeeCode: string; derivedWage: boolean }> {
    const emp = await this.#db.employee.findUnique({ where: { code: input.employeeCode } });
    if (!emp) throw new LeaveError(`Personel bulunamadı: ${input.employeeCode}`);

    // Kullanılmayan izin: hak eksi kullanılan. Bekleyen talepler
    // sayılmaz — onaylanmamış izin kullanılmış sayılamaz.
    const balance = await this.balanceOf(input.employeeCode, input.terminatedAt);
    const unusedLeaveDays = Math.max(0, balance.entitled - balance.used);

    // ÜCRET TÜRETİLİRSE BU SÖYLENİR: giydirilmiş ücret, çıplak ücrete
    // yol/yemek/ikramiye eklenmiş hâlidir ve bordrodan gelmelidir.
    let daily = input.dailyGrossWage ?? null;
    let derived = false;
    if (daily === null && emp.grossSalary !== null) {
      daily = Math.round((Number(emp.grossSalary) / 30) * 100) / 100;
      derived = true;
    }

    const draft = draftTermination({
      hiredAt: emp.hiredAt,
      terminatedAt: input.terminatedAt,
      reason: input.reason,
      dailyGrossWage: daily,
      severanceCeilingPerYear: input.severanceCeilingPerYear ?? null,
      unusedLeaveDays,
    });

    if (derived) {
      (draft.unknowns as string[]).push(
        "Günlük ücret aylık brütün 30'a bölünmesiyle TÜRETİLDİ. Giydirilmiş ücret " +
          "(yol, yemek, ikramiye dahil) daha yüksektir ve tazminat ondan hesaplanır; " +
          "bu taslak EKSİK KALMIŞ olabilir.",
      );
    }

    return { ...draft, employeeCode: input.employeeCode, derivedWage: derived };
  }
}