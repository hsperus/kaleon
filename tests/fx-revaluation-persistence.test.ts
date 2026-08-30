/**
 * Kur değerlemesi — gerçek Postgres'e karşı.
 *
 * Saf mantık `fx-revaluation.test.ts`'te sınanıyor. Burada sınanan şey
 * ZİNCİRİN KENDİSİ: dövizli bir fatura deftere döviziyle giriyor mu,
 * açık bakiye sorgusu onu buluyor mu, değerleme fişi yazılıyor mu ve
 * mizan sonrasında hâlâ denk mi.
 *
 * Bu testin varlık sebebi somut: 030 göçünden önce yevmiye satırı
 * döviz taşımıyordu ve bu zincirin hiçbir halkası kurulamıyordu.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { JournalRepository } from "../src/db/journal-repository.js";
import { RevaluationRepository } from "../src/db/revaluation-repository.js";
import { revalue } from "../src/modules/finance/revaluation.js";
import type { RateQuote } from "../src/modules/finance/exchange.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_fxreval";
const USER = "00000000-0000-0000-0000-0000000000fc";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const q = (currency: string, rate: number, on: string): RateQuote => ({
  currency,
  rate,
  quotedAt: on,
  ageDays: 0,
  source: "TCMB",
});

describe.skipIf(!enabled)("kur değerlemesi kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let journal: JournalRepository;
  let repo: RevaluationRepository;
  let musteri: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    journal = new JournalRepository(db);
    repo = new RevaluationRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    for (const t of ["fx_revaluations", "journal_lines", "journal_entries"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    }
    for (const t of ["fx_revaluations", "journal_lines", "journal_entries"]) {
      await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
    for (const t of ["fx_revaluations", "journal_lines", "journal_entries"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }

    const p = await db.partner.upsert({
      where: { code: "FX-MUSTERI" },
      update: {},
      create: {
        id: "11111111-1111-1111-1111-111111111111",
        code: "FX-MUSTERI",
        legalName: "Daimler AG",
        normalized: "daimler ag",
        isCustomer: true,
      },
    });
    musteri = p.id;
  });

  /** 10.000 EUR'luk satış faturası, 38 kurdan. */
  async function dovizliFatura() {
    await journal.post({
      entryDate: d("2026-03-15"),
      description: "EUR satış faturası",
      sourceKind: "sales_invoice",
      sourceId: "INV-FX-1",
      userId: USER,
      lines: [
        {
          accountCode: "120",
          debit: 380_000,
          credit: 0,
          description: "INV-FX-1",
          partnerId: musteri,
          currency: "EUR",
          fxDebit: 10_000,
          fxCredit: 0,
          fxRate: 38,
        },
        { accountCode: "600", debit: 0, credit: 380_000, description: "INV-FX-1 satış" },
      ],
    });
  }

  it("DÖVİZ DEFTERE YAZILIR — fatura TL'ye dönüşürken para birimi kaybolmaz", async () => {
    await dovizliFatura();

    const line = await db.journalLine.findFirst({ where: { accountCode: "120" } });
    expect(line?.currency).toBe("EUR");
    expect(Number(line?.fxDebit)).toBe(10_000);
    expect(Number(line?.fxRate)).toBe(38);
  });

  it("TL SATIR DA DOLDURULUR — sorguda özel durum kalmasın", async () => {
    await dovizliFatura();

    const gelir = await db.journalLine.findFirst({ where: { accountCode: "600" } });
    expect(gelir?.currency).toBe("TRY");
    expect(Number(gelir?.fxCredit)).toBe(380_000);
    expect(Number(gelir?.fxRate)).toBe(1);
  });

  it("AÇIK BAKİYE SORGUSU DÖVİZLİ CARİYİ BULUR — geliri getirmez", async () => {
    await dovizliFatura();

    const balances = await repo.openBalances(d("2026-12-31"));
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      accountCode: "120",
      currency: "EUR",
      fxBalance: 10_000,
      bookBalance: 380_000,
      partnerName: "Daimler AG",
    });
  });

  it("DEĞERLEME FİŞİ YAZILIR — kambiyo kârı 646'ya gider", async () => {
    await dovizliFatura();

    const balances = await repo.openBalances(d("2026-12-31"));
    const r = revalue(balances, { EUR: q("EUR", 46, "2026-12-31") }, d("2026-12-31"));
    const written = await repo.post(r, USER);

    expect(written.documentNo).toBeTruthy();

    const kar = await db.journalLine.findFirst({ where: { accountCode: "646" } });
    expect(Number(kar?.credit)).toBe(80_000);

    const cari = await db.journalLine.findFirst({
      where: { accountCode: "120", entryId: written.entryId },
    });
    expect(Number(cari?.debit)).toBe(80_000);
    // Kur farkı bir TL olayıdır: cariye yeni döviz borcu doğmaz.
    expect(Number(cari?.fxDebit)).toBe(80_000);
    expect(cari?.currency).toBe("TRY");
  });

  it("DEĞERLEME SONRASI MİZAN HÂLÂ DENK", async () => {
    await dovizliFatura();
    const balances = await repo.openBalances(d("2026-12-31"));
    await repo.post(revalue(balances, { EUR: q("EUR", 46, "2026-12-31") }, d("2026-12-31")), USER);

    const tb = await journal.trialBalance(d("2026-01-01"), d("2026-12-31"));
    const debit = tb.rows.reduce((s, r) => s + r.debit, 0);
    const credit = tb.rows.reduce((s, r) => s + r.credit, 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
  });

  it("AYNI TARİHE İKİNCİ DEĞERLEME YAZILAMAZ — kâr iki kat olurdu", async () => {
    await dovizliFatura();
    const balances = await repo.openBalances(d("2026-12-31"));
    const r = revalue(balances, { EUR: q("EUR", 46, "2026-12-31") }, d("2026-12-31"));
    await repo.post(r, USER);

    await expect(repo.post(r, USER)).rejects.toThrow();
  });

  it("KOŞU KAYDI KULLANILAN KURU SAKLAR — denetimde sorulur", async () => {
    await dovizliFatura();
    const balances = await repo.openBalances(d("2026-12-31"));
    await repo.post(revalue(balances, { EUR: q("EUR", 46, "2026-12-31") }, d("2026-12-31")), USER);

    const run = await db.fxRevaluation.findFirst();
    expect(run?.rates).toMatchObject({ EUR: { rate: 46, quotedAt: "2026-12-31" } });
    expect(Number(run?.difference)).toBe(80_000);
  });

  it("KAPANMIŞ CARİ DEĞERLENMEZ — tahsilat sonrası risk yok", async () => {
    await dovizliFatura();
    // 10.000 EUR tahsil edildi (kur 40, TL karşılığı 400.000).
    await journal.post({
      entryDate: d("2026-06-01"),
      description: "EUR tahsilat",
      sourceKind: "payment",
      sourceId: "PAY-FX-1",
      userId: USER,
      lines: [
        { accountCode: "102", debit: 400_000, credit: 0, description: "tahsilat" },
        {
          accountCode: "120",
          debit: 0,
          credit: 400_000,
          description: "tahsilat",
          partnerId: musteri,
          currency: "EUR",
          fxDebit: 0,
          fxCredit: 10_000,
          fxRate: 40,
        },
      ],
    });

    const balances = await repo.openBalances(d("2026-12-31"));
    expect(balances).toHaveLength(0);
  });

  describe("satır tutarlılığı — veritabanı da savunur", () => {
    it("KUR SIFIR OLAMAZ", async () => {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO journal_lines (id, entry_id, line_no, account_code, debit, credit,
             description, currency, fx_debit, fx_credit, fx_rate)
           VALUES (gen_random_uuid(), gen_random_uuid(), 1, '120', 1, 0, 'x', 'EUR', 1, 0, 0)`,
        ),
      ).rejects.toThrow();
    });

    it("TL SATIRIN KURU 1 OLMAK ZORUNDA", async () => {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO journal_lines (id, entry_id, line_no, account_code, debit, credit,
             description, currency, fx_debit, fx_credit, fx_rate)
           VALUES (gen_random_uuid(), gen_random_uuid(), 1, '120', 1, 0, 'x', 'TRY', 1, 0, 32)`,
        ),
      ).rejects.toThrow();
    });
  });
});
