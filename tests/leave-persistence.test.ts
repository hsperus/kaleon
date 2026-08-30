/**
 * İzin ve vardiya — gerçek Postgres'e karşı.
 *
 * Asıl iddia: İZİN HAKKI TABLODA SAKLANMAZ, KANUNDAN HESAPLANIR. Saklansaydı
 * kıdem yılı dolduğunda kimse güncellemeyi hatırlamaz, çalışan eski hakkıyla
 * kalır ve sistem "hesapladı" göründüğü için kimse şüphelenmezdi.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { LeaveRepository } from "../src/db/leave-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_leave";

const HASAN = "00000000-0000-0000-0000-00000000a5a1";
const IK = "00000000-0000-0000-0000-0000000000e1";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe.skipIf(!enabled)("izin ve vardiya kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: LeaveRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new LeaveRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.shiftAssignment.deleteMany();
    await db.shift.deleteMany();
    await db.leaveRequest.deleteMany();
    await db.leaveAdjustment.deleteMany();
    await db.employee.deleteMany();

    await db.employee.create({
      data: {
        code: "E-1042",
        fullName: "Hasan Turan",
        normalized: normalizeName("Hasan Turan").core,
        department: "Kaynak",
        position: "Operatör",
        hiredAt: d("2020-03-01"),
      },
    });
  });

  describe("bakiye", () => {
    it("HAK KIDEMDEN HESAPLANIR — tabloda saklanmaz", async () => {
      // 2020-03 girişli çalışan 2026-06'da 6 yıllık: 20 gün.
      const b = await repo.balanceOf("E-1042", d("2026-06-15"));
      expect(b.entitled).toBe(20);
      expect(b.basis).toContain("md. 53");

      // Aynı çalışan 2024'te 4 yıllıktı: 14 gün. Kayıt değişmeden
      // cevabın değişmesi, hakkın hesaplandığının kanıtı.
      const eski = await repo.balanceOf("E-1042", d("2024-06-15"));
      expect(eski.entitled).toBe(14);
    });

    it("50 YAŞ ÜSTÜ KADEMESİ DOĞUM TARİHİNDEN UYGULANIR", async () => {
      await db.employee.create({
        data: {
          code: "E-2000",
          fullName: "Mehmet Yılmaz",
          normalized: normalizeName("Mehmet Yılmaz").core,
          department: "Montaj",
          position: "Ustabaşı",
          hiredAt: d("2023-01-01"),
          birthDate: d("1970-01-01"),
        },
      });
      const b = await repo.balanceOf("E-2000", d("2026-06-15"));
      expect(b.entitled).toBe(20);
      expect(b.basis).toContain("md. 53/son");
    });

    it("devreden gün hakka eklenir", async () => {
      await db.leaveAdjustment.create({
        data: {
          employeeId: (await db.employee.findUniqueOrThrow({ where: { code: "E-1042" } })).id,
          year: 2026,
          days: 4,
          reason: "2025'ten devir",
          createdBy: IK,
        },
      });
      expect((await repo.balanceOf("E-1042", d("2026-06-15"))).entitled).toBe(24);
    });
  });

  describe("izin talebi", () => {
    it("İŞ GÜNÜ SAYILIR — pazar düşülmez", async () => {
      // 15–21 Haziran 2026; 21'i pazar.
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-21"),
        requestedBy: HASAN,
      });
      expect(r.workingDays).toBe(6);
    });

    it("RESMÎ TATİL DE DÜŞÜLMEZ", async () => {
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
        holidays: [d("2026-06-17")],
      });
      expect(r.workingDays).toBe(4);
    });

    it("BEKLEYEN TALEP BAKİYEDEN DÜŞÜLÜR", async () => {
      await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      const b = await repo.balanceOf("E-1042", d("2026-06-15"));
      expect(b.pending).toBe(5);
      expect(b.remaining).toBe(15);
    });

    it("ÇAKIŞAN İZİN REDDEDİLİR", async () => {
      await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await expect(
        repo.request({
          employeeCode: "E-1042",
          type: "yillik",
          startDate: d("2026-06-18"),
          endDate: d("2026-06-22"),
          requestedBy: HASAN,
        }),
      ).rejects.toThrow(/zaten bir izin var/);
      expect(await db.leaveRequest.count()).toBe(1);
    });

    it("REDDEDİLMİŞ İZİN YENİ TALEBİ ENGELLEMEZ", async () => {
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await repo.reject(r.id, IK, "Üretim yoğunluğu nedeniyle");
      await expect(
        repo.request({
          employeeCode: "E-1042",
          type: "yillik",
          startDate: d("2026-06-15"),
          endDate: d("2026-06-19"),
          requestedBy: HASAN,
        }),
      ).resolves.toBeTruthy();
    });

    it("HAKTAN FAZLA İZİN ALINAMAZ", async () => {
      await expect(
        repo.request({
          employeeCode: "E-1042",
          type: "yillik",
          startDate: d("2026-06-01"),
          endDate: d("2026-08-01"),
          requestedBy: HASAN,
        }),
      ).rejects.toThrow(/Kalan yıllık izin/);
    });

    it("MAZERET İZNİ BAKİYEDEN BAĞIMSIZ ALINIR", async () => {
      // Yıllık izni bitmiş olsa bile ölüm izni verilir.
      await expect(
        repo.request({
          employeeCode: "E-1042",
          type: "olum",
          startDate: d("2026-06-15"),
          endDate: d("2026-06-17"),
          requestedBy: HASAN,
        }),
      ).resolves.toMatchObject({ workingDays: 3 });

      // Ve yıllık bakiyeyi hiç etkilemez.
      const b = await repo.balanceOf("E-1042", d("2026-06-15"));
      expect(b.used).toBe(0);
      expect(b.pending).toBe(0);
    });

    it("BİR YILI DOLDURMAYAN ÇALIŞAN YILLIK İZİN ALAMAZ", async () => {
      await db.employee.create({
        data: {
          code: "E-9999",
          fullName: "Yeni Başlayan",
          normalized: normalizeName("Yeni Başlayan").core,
          department: "Montaj",
          position: "Operatör",
          hiredAt: d("2025-10-01"),
        },
      });
      await expect(
        repo.request({
          employeeCode: "E-9999",
          type: "yillik",
          startDate: d("2026-06-15"),
          endDate: d("2026-06-16"),
          requestedBy: HASAN,
        }),
      ).rejects.toThrow(/bir yılı doldurmayan/);
    });
  });

  describe("onay", () => {
    it("KENDİ İZNİNİ ONAYLAYAMAZ", async () => {
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await expect(repo.approve(r.id, HASAN)).rejects.toThrow(/Kendi izin talebinizi/);
    });

    it("KENDİ İZNİNİ ONAYLAMA VERİTABANINDA DA ENGELLİ", async () => {
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "leave_requests" SET "status"='approved', "approved_by"='${HASAN}',
             "updated_at"=NOW() WHERE "id"='${r.id}'`,
        ),
      ).rejects.toThrow();
    });

    it("onaylanan izin kullanılana geçer", async () => {
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await repo.approve(r.id, IK);
      const b = await repo.balanceOf("E-1042", d("2026-06-15"));
      expect(b.used).toBe(5);
      expect(b.pending).toBe(0);
      expect(b.remaining).toBe(15);
    });

    it("aynı izin iki kez onaylanamaz", async () => {
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await repo.approve(r.id, IK);
      await expect(repo.approve(r.id, IK)).rejects.toThrow(/approved durumunda/);
    });
  });

  describe("vardiya", () => {
    const gunduz = {
      code: "V1",
      name: "Gündüz",
      startsAt: "08:00",
      endsAt: "17:00",
      breakMinutes: 60,
      isNight: false,
    };

    it("KANUNÎ SINIR TANIM ANINDA REDDEDİLİR — kayıt oluşmaz", async () => {
      await expect(
        repo.defineShift({
          code: "GECE",
          name: "Gece",
          startsAt: "22:00",
          endsAt: "07:00",
          breakMinutes: 60,
          isNight: true,
        }),
      ).rejects.toThrow(/7.5 saati aşamaz/);
      expect(await db.shift.count()).toBe(0);
    });

    it("geçerli vardiya kaydedilir ve net süresi döner", async () => {
      expect(await repo.defineShift(gunduz)).toMatchObject({ hours: 8 });
      expect(await db.shift.count()).toBe(1);
    });

    it("ONAYLI İZİNDEKİ KİŞİYE VARDİYA ATANMAZ", async () => {
      await repo.defineShift(gunduz);
      const r = await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await repo.approve(r.id, IK);

      await expect(
        repo.assignShift({ employeeCode: "E-1042", shiftCode: "V1", workDate: d("2026-06-17") }),
      ).rejects.toThrow(/onaylı izinde/);
    });

    it("onay bekleyen izin vardiyayı engellemez", async () => {
      await repo.defineShift(gunduz);
      await repo.request({
        employeeCode: "E-1042",
        type: "yillik",
        startDate: d("2026-06-15"),
        endDate: d("2026-06-19"),
        requestedBy: HASAN,
      });
      await expect(
        repo.assignShift({ employeeCode: "E-1042", shiftCode: "V1", workDate: d("2026-06-17") }),
      ).resolves.toBeUndefined();
    });

    it("AYNI GÜNE İKİNCİ VARDİYA ATANMAZ — üzerine yazar", async () => {
      await repo.defineShift(gunduz);
      await repo.defineShift({ ...gunduz, code: "V2", name: "Akşam", startsAt: "14:00", endsAt: "23:00" });
      await repo.assignShift({ employeeCode: "E-1042", shiftCode: "V1", workDate: d("2026-06-17") });
      await repo.assignShift({ employeeCode: "E-1042", shiftCode: "V2", workDate: d("2026-06-17") });
      // İki satır olsaydı mesai iki kez hesaplanır ve bordro şişerdi.
      expect(await db.shiftAssignment.count()).toBe(1);
    });

    it("HAFTALIK 45 SAAT AŞIMI FAZLA MESAİ OLARAK RAPORLANIR", async () => {
      await repo.defineShift({ ...gunduz, endsAt: "19:00" }); // 10 saat net
      for (const day of ["15", "16", "17", "18", "19"]) {
        await repo.assignShift({
          employeeCode: "E-1042",
          shiftCode: "V1",
          workDate: d(`2026-06-${day}`),
        });
      }
      const plan = await repo.weeklyPlan("E-1042", d("2026-06-15"));
      expect(plan.totalHours).toBe(50);
      expect(plan.overtime).toBe(5);
      expect(plan.exceedsLimit).toBe(true);
    });
  });
});
