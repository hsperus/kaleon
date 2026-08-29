/**
 * Puantaj ve fazla mesai — gerçek Postgres'e karşı.
 *
 * Bu dosyadaki testler bir bordro hatasının nasıl doğduğunu anlatır:
 * hafta sonunu hafta içi saymak, onay bekleyen mesaiyi kesinleşmiş göstermek,
 * aynı dakikayı iki kez toplamak. Üçü de sessiz hatalardır — kimse ay
 * sonunda "bu rakam nereden geldi" diye soramaz.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaAttendanceSource, periodRange } from "../src/db/attendance-source.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_att";

describe("dönem aralığı", () => {
  it("ay başından ertesi ay başına kadar — yarı açık", () => {
    const r = periodRange("2026-05");
    expect(r.from.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("aralık yılı doğru devreder", () => {
    const r = periodRange("2026-12");
    expect(r.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("geçersiz dönem sessizce kabul edilmez", () => {
    expect(() => periodRange("2026-13")).toThrow(/Geçersiz dönem/);
    expect(() => periodRange("saçma")).toThrow(/Geçersiz dönem/);
  });
});

describe.skipIf(!enabled)("Puantaj kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let source: PrismaAttendanceSource;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    source = new PrismaAttendanceSource(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.attendanceDay.deleteMany();
    await db.employee.deleteMany();
  });

  async function employee(code: string, fullName: string, department: string, salary = 62_000) {
    return db.employee.create({
      data: {
        code,
        fullName,
        normalized: normalizeName(fullName).full,
        department,
        position: "Operatör",
        hiredAt: new Date("2020-01-01"),
        grossSalary: salary,
      },
    });
  }

  const Q = { employeeQuery: null, department: null, period: "2026-05" };

  async function day(
    employeeId: string,
    date: string,
    worked: number,
    opts: { planned?: number; weekend?: boolean; holiday?: boolean; approved?: boolean } = {},
  ) {
    return db.attendanceDay.create({
      data: {
        employeeId,
        workDate: new Date(date),
        workedMinutes: worked,
        plannedMinutes: opts.planned ?? 480,
        isWeekend: opts.weekend ?? false,
        isHoliday: opts.holiday ?? false,
        approvedAt: opts.approved ? new Date("2026-05-20T10:00:00Z") : null,
      },
    });
  }

  it("FAZLA MESAİ HESAPLANIR — planlanan sürenin üstü", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-04", 600); // 480 plan → 120 fazla
    await day(e.id, "2026-05-05", 540); // 60 fazla
    const { rows } = await source.overtime(Q);
    expect(rows[0]).toMatchObject({ employeeId: "E-1042", weekdayMinutes: 180, weekendMinutes: 0 });
  });

  it("planlanan sürenin altında çalışmak EKSİ mesai üretmez", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-04", 300); // yarım gün
    await day(e.id, "2026-05-05", 600); // 120 fazla
    const { rows } = await source.overtime(Q);
    // Eksik gün fazla mesaiden DÜŞÜLMEZ; ikisi ayrı hesaplardır.
    expect(rows[0]!.weekdayMinutes).toBe(120);
  });

  it("HAFTA SONU MESAİSİ AYRI TUTULUR — çarpanı farklıdır", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-09", 480, { weekend: true });
    const { rows } = await source.overtime(Q);
    expect(rows[0]).toMatchObject({ weekdayMinutes: 0, weekendMinutes: 480 });
  });

  it("hafta sonunda çalışılan sürenin TAMAMI mesaidir", async () => {
    // Planlanan 480 olsa bile hafta sonunda normal mesai yoktur.
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-09", 480, { weekend: true, planned: 480 });
    const { rows } = await source.overtime(Q);
    expect(rows[0]!.weekendMinutes).toBe(480);
  });

  it("resmî tatil hafta sonu gibi sayılır", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-19", 300, { holiday: true });
    const { rows } = await source.overtime(Q);
    expect(rows[0]).toMatchObject({ weekdayMinutes: 0, weekendMinutes: 300 });
  });

  it("ONAY BEKLEYEN MESAİ AYRI RAPORLANIR — tutar kesinleşmemiştir", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-04", 600, { approved: true }); // 120, onaylı
    await day(e.id, "2026-05-05", 600); // 120, onaysız
    const { rows } = await source.overtime(Q);
    expect(rows[0]).toMatchObject({ weekdayMinutes: 240, pendingApprovalMinutes: 120 });
  });

  it("onay bekleyen dakikalar toplamın İÇİNDEDİR — iki kez sayılmaz", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-04", 600);
    const { rows } = await source.overtime(Q);
    const r = rows[0]!;
    // Toplam 120; onay bekleyen de aynı 120. Toplarken 240 çıkmamalı.
    expect(r.weekdayMinutes + r.weekendMinutes).toBe(120);
    expect(r.pendingApprovalMinutes).toBe(120);
  });

  it("DÖNEM SINIRI KESKİN — önceki/sonraki ay karışmaz", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-04-30", 900); // önceki ay
    await day(e.id, "2026-05-04", 600); // dönem içi
    await day(e.id, "2026-06-01", 900); // sonraki ay
    const { rows } = await source.overtime(Q);
    expect(rows[0]!.weekdayMinutes).toBe(120);
  });

  it("departman filtresi", async () => {
    const a = await employee("E-1", "Hasan Turan", "Kaynak");
    const b = await employee("E-2", "Ayşe Demir", "Montaj");
    await day(a.id, "2026-05-04", 600);
    await day(b.id, "2026-05-04", 600);
    const { rows } = await source.overtime({ ...Q, department: "Montaj" });
    expect(rows.map((r) => r.employeeName)).toEqual(["Ayşe Demir"]);
  });

  it("AD ARAMASI TÜRKÇE-DUYARLI — 'ayse' de 'Ayşe'yi bulur", async () => {
    const b = await employee("E-2", "Ayşe Demir", "Montaj");
    await day(b.id, "2026-05-04", 600);
    for (const q of ["Ayşe", "ayse", "AYŞE", "demir"]) {
      const { rows } = await source.overtime({ ...Q, employeeQuery: q });
      expect(rows.map((r) => r.employeeName), q).toEqual(["Ayşe Demir"]);
    }
  });

  it("mesaisi olmayan çalışan listelenmez", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-04", 480); // tam gün, fazla yok
    expect((await source.overtime(Q)).rows).toEqual([]);
  });

  it("işten ayrılmış çalışan listelenmez", async () => {
    const e = await employee("E-9", "Ayrılan Kişi", "Kaynak");
    await day(e.id, "2026-05-04", 600);
    await db.employee.update({ where: { id: e.id }, data: { isActive: false } });
    expect((await source.overtime(Q)).rows).toEqual([]);
  });

  it("en çok mesai yapan başta gelir", async () => {
    const a = await employee("E-1", "Az Mesai", "Kaynak");
    const b = await employee("E-2", "Çok Mesai", "Kaynak");
    await day(a.id, "2026-05-04", 540);
    await day(b.id, "2026-05-04", 720);
    const { rows } = await source.overtime(Q);
    expect(rows.map((r) => r.employeeName)).toEqual(["Çok Mesai", "Az Mesai"]);
  });

  it("bir çalışanın bir günü tektir — senkronizasyon tekrarı idempotent", async () => {
    const e = await employee("E-1042", "Hasan Turan", "Kaynak");
    await day(e.id, "2026-05-04", 600);
    await expect(day(e.id, "2026-05-04", 999)).rejects.toThrow();
  });

  it("maaşı tanımsız çalışan çökertmez", async () => {
    const e = await db.employee.create({
      data: {
        code: "E-77",
        fullName: "Maaşsız Kayıt",
        normalized: normalizeName("Maaşsız Kayıt").full,
        department: "Kaynak",
        position: "Stajyer",
        hiredAt: new Date("2026-01-01"),
      },
    });
    await day(e.id, "2026-05-04", 600);
    const { rows } = await source.overtime(Q);
    expect(rows[0]!.grossSalaryTry).toBe(0);
  });

  it("kayıt yoksa boş döner, uydurma satır üretmez", async () => {
    expect((await source.overtime(Q)).rows).toEqual([]);
  });
});
