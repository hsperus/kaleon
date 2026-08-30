/**
 * Bordro kalıcılığı.
 *
 * BORDRO ÇALIŞTIRMAK GERİ ALINAMAZ. Testler bunun sonuçlarını
 * sınıyor: aynı dönem iki kez çalıştırılabiliyor mu, kümülatif matrah
 * aylar arasında doğru yürüyor mu, muhasebe kaydı ödenecek borcu
 * doğru yerlere yazıyor mu ve ücreti tanımsız çalışan sıfırla
 * bordroya giriyor mu.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PayrollRepository, PayrollRepositoryError } from "../src/db/payroll-repository.js";
import { JournalRepository } from "../src/db/journal-repository.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_payroll";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!enabled)("bordro kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: PayrollRepository;
  let journal: JournalRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new PayrollRepository(db);
    journal = new JournalRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`ALTER TABLE "payroll_lines" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "payroll_lines"`);
    await db.$executeRawUnsafe(`ALTER TABLE "payroll_lines" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "payroll_runs"`);
    await db.$executeRawUnsafe(`DELETE FROM "employees"`);
    for (const t of ["journal_lines", "journal_entries"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
      await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
    await db.$executeRawUnsafe(`DELETE FROM "document_number_ranges"`);

    await db.employee.createMany({
      data: [
        {
          code: "P-001", fullName: "Ayşe Yılmaz", normalized: "ayse yilmaz",
          department: "Üretim", position: "Operatör",
          hiredAt: new Date("2024-03-01"), grossSalary: 33_030, isActive: true,
        },
        {
          code: "P-002", fullName: "Mehmet Kaya", normalized: "mehmet kaya",
          department: "Muhasebe", position: "Muhasebeci",
          hiredAt: new Date("2023-01-15"), grossSalary: 120_000, isActive: true,
        },
      ],
    });
  });

  const march = new Date(Date.UTC(2026, 2, 15));

  it("bordro çalışır ve yevmiyeye kayıt düşer", async () => {
    const r = await repo.run({ period: march, userId: USER });
    expect(r.employeeCount).toBe(2);
    expect(r.documentNo).toBeTruthy();

    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: r.documentNo! },
      include: { lines: true },
    });
    // 335 Personele Borçlar = toplam net.
    expect(Number(entry.lines.find((l) => l.accountCode === "335")?.credit)).toBe(r.totalNet);
    // İŞVEREN PAYI DA GİDERDİR: 770 borcu brütten büyük olmalı.
    const expense = Number(entry.lines.find((l) => l.accountCode === "770")?.debit);
    expect(expense).toBeGreaterThan(r.totalGross);
    // SGK ve vergi borçları ayrı hesaplarda.
    expect(entry.lines.find((l) => l.accountCode === "361")).toBeTruthy();
    expect(entry.lines.find((l) => l.accountCode === "360")).toBeTruthy();
  });

  it("AYNI DÖNEM İKİ KEZ ÇALIŞTIRILAMAZ", async () => {
    // Çift bordro, çift SGK bildirimi ve çift ödeme demektir.
    await repo.run({ period: march, userId: USER });
    await expect(repo.run({ period: march, userId: USER })).rejects.toThrow(
      PayrollRepositoryError,
    );
  });

  it("ayın hangi günü verilirse verilsin AYNI DÖNEM sayılır", async () => {
    await repo.run({ period: new Date(Date.UTC(2026, 2, 1)), userId: USER });
    await expect(
      repo.run({ period: new Date(Date.UTC(2026, 2, 28)), userId: USER }),
    ).rejects.toThrow(/zaten çalıştırıldı/);
  });

  it("KÜMÜLATİF MATRAH AYLAR ARASINDA YÜRÜR", async () => {
    /*
     * Bordronun en pahalı hatası: her ay bağımsız hesaplansaydı
     * çalışan yıl boyunca %15 diliminde kalır ve yıl sonunda devasa
     * bir vergi farkı çıkardı.
     */
    await repo.run({ period: new Date(Date.UTC(2026, 0, 15)), userId: USER });
    await repo.run({ period: new Date(Date.UTC(2026, 1, 15)), userId: USER });

    const ocak = await repo.payslip("P-002", new Date(Date.UTC(2026, 0, 15)));
    const subat = await repo.payslip("P-002", new Date(Date.UTC(2026, 1, 15)));
    expect(ocak!.cumulativeBefore).toBe(0);
    expect(subat!.cumulativeBefore).toBe(ocak!.cumulativeAfter);
  });

  it("YIL DÖNÜMÜNDE KÜMÜLATİF SIFIRLANIR", async () => {
    // Devrolsaydı ikinci yılın ocak ayında çalışan en üst dilimden
    // vergilendirilirdi.
    await repo.run({ period: new Date(Date.UTC(2026, 11, 15)), userId: USER });
    const before = await repo.cumulativeBefore(
      (await db.employee.findUniqueOrThrow({ where: { code: "P-002" } })).id,
      new Date(Date.UTC(2027, 0, 15)),
    );
    expect(before).toBe(0);
  });

  it("ÜCRETİ TANIMSIZ ÇALIŞAN SIFIRLA BORDROYA GİRMEZ", async () => {
    // Sıfır ücretli bir satır, SGK'ya sıfır kazanç bildirmek demektir.
    await db.employee.create({
      data: {
        code: "P-003", fullName: "Ali Demir", normalized: "ali demir",
        department: "Satış", position: "Temsilci",
        hiredAt: new Date("2025-06-01"), isActive: true,
      },
    });
    const r = await repo.run({ period: march, userId: USER });
    expect(r.employeeCount).toBe(2);
    expect(r.skipped.map((s) => s.code)).toContain("P-003");
  });

  it("İŞTEN AYRILMIŞ ÇALIŞAN BORDROYA GİRMEZ", async () => {
    await db.employee.update({
      where: { code: "P-001" },
      data: { terminatedAt: new Date("2026-01-31"), isActive: false },
    });
    const r = await repo.run({ period: march, userId: USER });
    expect(r.employeeCount).toBe(1);
    expect(r.lines.map((l) => l.code)).toEqual(["P-002"]);
  });

  it("DÖNEMDEN SONRA İŞE GİREN BORDROYA GİRMEZ", async () => {
    await db.employee.create({
      data: {
        code: "P-004", fullName: "Zeynep Ak", normalized: "zeynep ak",
        department: "Satış", position: "Temsilci",
        hiredAt: new Date("2026-08-01"), grossSalary: 50_000, isActive: true,
      },
    });
    const r = await repo.run({ period: march, userId: USER });
    expect(r.lines.map((l) => l.code)).not.toContain("P-004");
  });

  it("asgari ücretli çalışanın neti 28.075,50 olur", async () => {
    await repo.run({ period: march, userId: USER });
    const p = await repo.payslip("P-001", march);
    expect(p!.netSalary).toBe(28_075.5);
    expect(p!.incomeTax).toBe(0);
  });

  it("ÇALIŞTIRILMIŞ BORDRO DEĞİŞTİRİLEMEZ", async () => {
    await repo.run({ period: march, userId: USER });
    await expect(
      db.$executeRawUnsafe(`UPDATE "payroll_lines" SET "net_salary" = 1`),
    ).rejects.toThrow(/değiştirilemez/);
  });

  it("bordro kaydı MİZANI BOZMAZ", async () => {
    await repo.run({ period: march, userId: USER });
    const tb = await journal.trialBalance(new Date("2026-01-01"), new Date("2026-12-31"));
    expect(tb.balanced).toBe(true);
  });

  it("dönem özeti çalışan kırılımıyla döner", async () => {
    await repo.run({ period: march, userId: USER });
    const s = await repo.summary(march);
    expect(s!.employeeCount).toBe(2);
    expect(s!.employees).toHaveLength(2);
    expect(s!.totalEmployerCost).toBeGreaterThan(s!.totalGross);
    expect(s!.parameterYear).toBe(2026);
  });

  it("HİÇ ÇALIŞAN YOKSA BORDRO ÇALIŞMAZ", async () => {
    await db.$executeRawUnsafe(`DELETE FROM "employees"`);
    await expect(repo.run({ period: march, userId: USER })).rejects.toThrow(
      /aktif çalışan yok/,
    );
  });

  it("PARAMETRESİ OLMAYAN YIL İÇİN BORDRO ÇALIŞMAZ", async () => {
    // Geçen yılın oranlarıyla bu yılın bordrosunu üretmektense hata
    // vermek doğrudur.
    await expect(
      repo.run({ period: new Date(Date.UTC(2031, 2, 15)), userId: USER }),
    ).rejects.toThrow(/parametreleri tanımlı değil/);
  });
});
