/**
 * Puantaj / fazla mesai — Postgres adaptörü.
 *
 * FAZLA MESAİ SAKLANMAZ, HESAPLANIR.
 * Veritabanında yalnızca "o gün kaç dakika çalışıldı" ve "o gün için kaç
 * dakika planlanmıştı" durur. Fazlası aradaki farktır. Saklanmış bir
 * "fazla mesai" alanı, normal mesai tanımı değiştiğinde (mevzuat, toplu
 * sözleşme, vardiya değişikliği) geçmişi yanlış göstermeye başlardı.
 *
 * ÜÇ AYRIM KORUNUR VE BİRBİRİNE KARIŞTIRILMAZ:
 *
 *   hafta içi mesai  → normal çarpan
 *   hafta sonu/tatil → farklı çarpan (gün TAMAMEN hafta sonu mesaisidir,
 *                      planlanan süre 0 kabul edilir)
 *   onay bekleyen    → henüz kesinleşmemiş; tutarı söylerken bu ayrı
 *                      söylenmelidir, aksi hâlde kesinleşmiş gibi okunur
 *
 * Onay bekleyen dakikalar hafta içi/hafta sonu toplamlarının İÇİNDEDİR;
 * ayrı bir kalem değil, aynı dakikaların onay durumudur. Toplarken iki kez
 * sayılmamalıdır — bu ayrımı kaybetmek bordroda çift ödeme demektir.
 */

import type { OvertimeRecord, WithFreshness } from "../data/port.js";
import { fold } from "../modules/master-data/normalize.js";
import { toMoney } from "./decimal.js";
import { MAX_ROWS, limitCaveat } from "./query-limits.js";
import type { TenantDb } from "./client.js";

export interface OvertimeQuery {
  readonly employeeQuery: string | null;
  readonly department: string | null;
  /** YYYY-AA */
  readonly period: string;
}

/** Dönemin ilk günü ve ertesi ayın ilk günü (yarı açık aralık). */
export function periodRange(period: string): { from: Date; to: Date } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    throw new Error(`Geçersiz dönem: ${period}`);
  }
  return {
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)),
  };
}

export class PrismaAttendanceSource {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async overtime(query: OvertimeQuery): Promise<WithFreshness<readonly OvertimeRecord[]>> {
    const { from, to } = periodRange(query.period);

    const days = await this.#db.attendanceDay.findMany({
      where: {
        workDate: { gte: from, lt: to },
        employee: {
          ...(query.department ? { department: query.department } : {}),
          isActive: true,
        },
      },
      include: {
        employee: {
          select: {
            id: true,
            code: true,
            fullName: true,
            normalized: true,
            department: true,
            grossSalary: true,
          },
        },
      },
      orderBy: { workDate: "asc" },
      take: MAX_ROWS,
    });

    // Ad araması veritabanında değil burada: normalize edilmiş sütun
    // üzerinden Türkçe-duyarlı katlama ile eşleşir. "Hasan" araması
    // "HASAN TURAN" kaydını da bulur.
    const needle = query.employeeQuery ? fold(query.employeeQuery) : null;

    const byEmployee = new Map<string, OvertimeAccumulator>();

    for (const day of days) {
      const emp = day.employee;
      if (needle && !emp.normalized.includes(needle) && !fold(emp.fullName).includes(needle)) {
        continue;
      }

      const acc =
        byEmployee.get(emp.id) ??
        {
          employeeId: emp.code,
          employeeName: emp.fullName,
          department: emp.department,
          weekdayMinutes: 0,
          weekendMinutes: 0,
          pendingApprovalMinutes: 0,
          grossSalaryTry: toMoney(emp.grossSalary) ?? 0,
        };

      // Hafta sonu/tatilde çalışılan sürenin TAMAMI fazla mesaidir;
      // o gün için planlanan normal süre yoktur.
      const restDay = day.isWeekend || day.isHoliday;
      const overtime = restDay
        ? day.workedMinutes
        : Math.max(0, day.workedMinutes - day.plannedMinutes);

      if (overtime === 0) {
        byEmployee.set(emp.id, acc);
        continue;
      }

      if (restDay) acc.weekendMinutes += overtime;
      else acc.weekdayMinutes += overtime;

      // Onay bekleyen dakikalar yukarıdaki toplamların İÇİNDEDİR.
      if (day.approvedAt === null) acc.pendingApprovalMinutes += overtime;

      byEmployee.set(emp.id, acc);
    }

    const rows = [...byEmployee.values()]
      // Mesaisi hiç olmayan çalışan listelenmez — cevabı gürültüyle doldurur.
      .filter((r) => r.weekdayMinutes > 0 || r.weekendMinutes > 0)
      .sort((a, b) => b.weekdayMinutes + b.weekendMinutes - (a.weekdayMinutes + a.weekendMinutes));

    // Tazelik: dönemin en SON puantaj kaydının yazıldığı an. Kayıt yoksa
    // "şimdi" demek yanıltıcı olurdu; dönemin sonu kullanılır.
    const latest = days.reduce<Date | null>(
      (max, d) => (max === null || d.updatedAt > max ? d.updatedAt : max),
      null,
    );

    const limited = limitCaveat(days.length, "Puantaj kayıtları");

    return {
      rows,
      freshness: {
        syncedAt: (latest ?? to).toISOString(),
        recordCount: rows.length,
      },
      ...(limited ? { caveats: [limited] } : {}),
    };
  }
}

interface OvertimeAccumulator {
  employeeId: string;
  employeeName: string;
  department: string;
  weekdayMinutes: number;
  weekendMinutes: number;
  pendingApprovalMinutes: number;
  grossSalaryTry: number;
}
