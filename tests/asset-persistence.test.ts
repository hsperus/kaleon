/**
 * Sabit kıymet kalıcılığı.
 *
 * AMORTİSMAN VERGİ MATRAHINI DEĞİŞTİRİR ve yevmiyeye kayıt yazar.
 * Buradaki testler hesabın kendisini değil KAYIT DAVRANIŞINI sınıyor:
 * aynı yıl iki kez ayrılabiliyor mu, geçmiş yıl atlanabiliyor mu,
 * elden çıkarma bilançoyu doğru kapatıyor mu.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { AssetRepository, AssetError } from "../src/db/asset-repository.js";
import { JournalRepository } from "../src/db/journal-repository.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_assets";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!enabled)("sabit kıymet kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: AssetRepository;
  let journal: JournalRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new AssetRepository(db);
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
    // Ayrılmış amortisman değiştirilemez — tetikleyici doğru çalışıyor.
    // Test verisini temizlemek için geçici olarak kapatılır; uygulama
    // kodunun böyle bir yolu YOKTUR.
    await db.$executeRawUnsafe(`ALTER TABLE "depreciation_runs" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "depreciation_runs"`);
    await db.$executeRawUnsafe(`ALTER TABLE "depreciation_runs" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "fixed_assets"`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "journal_lines"`);
    await db.$executeRawUnsafe(`DELETE FROM "journal_entries"`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
  });

  const machine = {
    code: "SK-001",
    name: "CNC Torna",
    category: "makine",
    acquiredAt: new Date("2026-01-10"),
    cost: 500_000,
    usefulLifeYears: 5,
    method: "normal" as const,
    prorated: false,
    assetAccount: "253",
    expenseAccount: "730",
  };

  it("kıymet açılır ve net defter değeri maliyete eşittir", async () => {
    const a = await repo.create(machine);
    expect(a.bookValue).toBe(500_000);
    expect(a.accumulated).toBe(0);
    expect(a.status).toBe("aktif");
  });

  it("AYNI KOD İKİ KEZ AÇILAMAZ", async () => {
    await repo.create(machine);
    await expect(repo.create(machine)).rejects.toThrow(AssetError);
  });

  it("amortisman ayrılır ve YEVMİYEYE KAYIT DÜŞER", async () => {
    await repo.create(machine);
    const r = await repo.run({ year: 2026, userId: USER });

    expect(r.posted).toHaveLength(1);
    expect(r.total).toBe(100_000);
    expect(r.documentNo).toBeTruthy();

    // Kayıt gerçekten yazıldı mı — 730 borç, 257 alacak.
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: r.documentNo! },
      include: { lines: true },
    });
    const expense = entry.lines.find((l) => l.accountCode === "730");
    const accum = entry.lines.find((l) => l.accountCode === "257");
    expect(Number(expense?.debit)).toBe(100_000);
    expect(Number(accum?.credit)).toBe(100_000);
  });

  it("AYNI YIL İKİ KEZ AYRILAMAZ", async () => {
    // Çift ayrılan amortisman matrahı yarı yarıya düşürür.
    await repo.create(machine);
    await repo.run({ year: 2026, userId: USER });
    const second = await repo.run({ year: 2026, userId: USER });
    expect(second.posted).toHaveLength(0);
    expect(second.skipped[0]!.reason).toContain("zaten ayrılmış");
  });

  it("GEÇMİŞ YIL ATLANARAK AYRILAMAZ", async () => {
    // 2026 ayrılmadan 2027 ayrılırsa birikmiş amortisman tabloyla tutmaz.
    await repo.create(machine);
    const r = await repo.run({ year: 2027, userId: USER });
    expect(r.posted).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("2026");
  });

  it("iktisap tarihinden önceki yıl ayrılmaz", async () => {
    await repo.create(machine);
    const r = await repo.run({ year: 2025, userId: USER });
    expect(r.skipped[0]!.reason).toContain("iktisap");
  });

  it("TAM AMORTİ OLAN KIYMET DURUM DEĞİŞTİRİR", async () => {
    await repo.create(machine);
    for (const y of [2026, 2027, 2028, 2029, 2030]) {
      await repo.run({ year: y, userId: USER });
    }
    const found = await repo.byCode("SK-001");
    expect(found!.asset.status).toBe("tam_amorti");
    expect(found!.asset.bookValue).toBe(0);
    expect(found!.asset.accumulated).toBe(500_000);
  });

  it("BİRİKMİŞ AMORTİSMAN AYRILDIKÇA ARTAR", async () => {
    await repo.create(machine);
    await repo.run({ year: 2026, userId: USER });
    await repo.run({ year: 2027, userId: USER });
    const found = await repo.byCode("SK-001");
    expect(found!.asset.accumulated).toBe(200_000);
    expect(found!.asset.bookValue).toBe(300_000);
  });

  it("elden çıkarma KÂRI 649'A yazar — 600'e değil", async () => {
    // Makine satmak ciro değildir; 600'e yazılsaydı brüt kâr marjı bozulurdu.
    await repo.create(machine);
    await repo.run({ year: 2026, userId: USER });
    const r = await repo.dispose({
      code: "SK-001",
      disposedAt: new Date("2027-03-01"),
      proceeds: 450_000,
      userId: USER,
      counterAccount: "102",
    });
    expect(r.bookValue).toBe(400_000);
    expect(r.gain).toBe(50_000);

    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: r.documentNo },
      include: { lines: true },
    });
    expect(entry.lines.find((l) => l.accountCode === "649")).toBeTruthy();
    expect(entry.lines.find((l) => l.accountCode === "600")).toBeUndefined();
    // Kıymet hesabı MALİYET tutarıyla kapanır.
    expect(Number(entry.lines.find((l) => l.accountCode === "253")?.credit)).toBe(500_000);
    // Birikmiş amortisman da kapanır.
    expect(Number(entry.lines.find((l) => l.accountCode === "257")?.debit)).toBe(100_000);
  });

  it("zararına satış 659'a yazılır", async () => {
    await repo.create(machine);
    const r = await repo.dispose({
      code: "SK-001",
      disposedAt: new Date("2026-06-01"),
      proceeds: 300_000,
      userId: USER,
      counterAccount: "102",
    });
    expect(r.gain).toBe(-200_000);
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: r.documentNo },
      include: { lines: true },
    });
    expect(Number(entry.lines.find((l) => l.accountCode === "659")?.debit)).toBe(200_000);
  });

  it("ELDEN ÇIKARILAN KIYMET İKİNCİ KEZ ÇIKARILAMAZ", async () => {
    await repo.create(machine);
    await repo.dispose({
      code: "SK-001",
      disposedAt: new Date("2026-06-01"),
      proceeds: 100,
      userId: USER,
      counterAccount: "100",
    });
    await expect(
      repo.dispose({
        code: "SK-001",
        disposedAt: new Date("2026-07-01"),
        proceeds: 100,
        userId: USER,
        counterAccount: "100",
      }),
    ).rejects.toThrow(AssetError);
  });

  it("elden çıkarılan kıymet amortisman koşusuna GİRMEZ", async () => {
    await repo.create(machine);
    await repo.dispose({
      code: "SK-001",
      disposedAt: new Date("2026-06-01"),
      proceeds: 100,
      userId: USER,
      counterAccount: "100",
    });
    await expect(repo.run({ year: 2026, userId: USER })).rejects.toThrow(/Aktif sabit kıymet yok/);
  });

  it("AYRILMIŞ AMORTİSMAN SİLİNEMEZ — veritabanı reddeder", async () => {
    await repo.create(machine);
    await repo.run({ year: 2026, userId: USER });
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "depreciation_runs"`),
    ).rejects.toThrow(/değiştirilemez|silinemez/);
  });

  it("amortisman kaydı MİZANI BOZMAZ", async () => {
    await repo.create(machine);
    await repo.run({ year: 2026, userId: USER });
    const tb = await journal.trialBalance(new Date("2026-01-01"), new Date("2026-12-31"));
    expect(tb.balanced).toBe(true);
  });

  it("MUTABAKAT AYRIŞMAYI YAKALAR", async () => {
    /*
     * Sabit kıymet kartı muhasebe kaydı yazmaz — kıymet satın alma
     * faturasıyla deftere girmiştir. Doğru bir ayrım ama risk taşır:
     * kart açılır, fatura kaydı unutulur ve bilanço ile kıymet listesi
     * farklı rakam söyler. Bu testin yakaladığı şey tam olarak odur.
     */
    await repo.create(machine);
    const drift = await repo.reconcile();
    expect(drift.matched).toBe(false);
    expect(drift.costDifference).toBe(500_000);

    // Alım kaydı yazılınca mutabakat sağlanır.
    await journal.post({
      entryDate: new Date("2026-01-10"),
      description: "Makine alımı",
      sourceKind: "manual",
      userId: USER,
      lines: [
        { accountCode: "253", debit: 500_000, credit: 0, description: "CNC Torna" },
        { accountCode: "102", debit: 0, credit: 500_000, description: "Ödeme" },
      ],
    });
    const ok = await repo.reconcile();
    expect(ok.costDifference).toBe(0);
    expect(ok.matched).toBe(true);
  });

  it("amortisman ayrıldıkça BİRİKMİŞ de mutabık kalır", async () => {
    await repo.create(machine);
    await journal.post({
      entryDate: new Date("2026-01-10"),
      description: "Makine alımı",
      sourceKind: "manual",
      userId: USER,
      lines: [
        { accountCode: "253", debit: 500_000, credit: 0, description: "CNC Torna" },
        { accountCode: "102", debit: 0, credit: 500_000, description: "Ödeme" },
      ],
    });
    await repo.run({ year: 2026, userId: USER });
    const r = await repo.reconcile();
    expect(r.registerAccumulated).toBe(100_000);
    expect(r.ledgerAccumulated).toBe(100_000);
    expect(r.matched).toBe(true);
  });

  it("toplu koşu birden fazla kıymeti tek fişe yazar", async () => {
    await repo.create(machine);
    await repo.create({ ...machine, code: "SK-002", name: "Freze", cost: 200_000 });
    const r = await repo.run({ year: 2026, userId: USER });
    expect(r.posted).toHaveLength(2);
    expect(r.total).toBe(140_000);
    const entries = await db.journalEntry.findMany();
    expect(entries).toHaveLength(1);
  });
});
