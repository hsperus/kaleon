/**
 * Yevmiye defteri — gerçek Postgres'e karşı.
 *
 * Asıl iddia: OPERASYON VE MALİ TABLO TEK KAYNAKTAN ÇIKAR. Fatura
 * kesildiğinde ciro mizanda görünür, sevkiyat yapıldığında maliyet
 * düşer, ödeme yapıldığında cari kapanır. İkisi ayrı beslenseydi ay
 * sonunda iki farklı gerçek doğar ve hangisinin doğru olduğunu kimse
 * söyleyemezdi.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { JournalRepository } from "../src/db/journal-repository.js";
import { SalesRepository } from "../src/db/sales-repository.js";
import { ValuationRepository } from "../src/db/valuation-repository.js";
import { ProcurementRepository } from "../src/db/procurement-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_journal";
const USER = "00000000-0000-0000-0000-0000000000aa";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe.skipIf(!enabled)("yevmiye kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let journal: JournalRepository;
  let sales: SalesRepository;
  let valuation: ValuationRepository;
  let procurement: ProcurementRepository;
  let customerId: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    journal = new JournalRepository(db);
    sales = new SalesRepository(db);
    valuation = new ValuationRepository(db);
    procurement = new ProcurementRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    for (const t of ["journal_lines", "journal_entries", "sales_invoice_lines", "sales_invoices"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    }
    for (const t of ["journal_lines", "journal_entries", "sales_invoice_lines", "sales_invoices"]) {
      await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
    for (const t of ["journal_lines", "journal_entries", "sales_invoice_lines", "sales_invoices"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
    await db.paymentAllocation.deleteMany();
    await db.payment.deleteMany();
    await db.invoiceLine.deleteMany();
    await db.invoice.deleteMany();
    await db.deliveryLine.deleteMany();
    await db.delivery.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.stockMovement.deleteMany();
    await db.itemCostState.deleteMany();
    await db.itemUnit.deleteMany();
    await db.item.deleteMany();
    await db.partner.deleteMany();
    await db.documentNumberRange.deleteMany();
    // Dönem kayıtları da temizlenir: bir testin kapattığı dönem, sonraki
    // testin yazmasını engeller ve hata testin kendisinde değil bir
    // öncekinde aranır.
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "accounting_periods"`);
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" ENABLE TRIGGER USER`);

    await db.item.create({
      data: {
        code: "MM-500",
        name: "Şasi Grubu",
        normalized: "sasi grubu",
        type: "mamul",
        baseUom: "adet",
      },
    });
    const c = await db.partner.create({
      data: {
        code: "M-0001",
        legalName: "Volvo Group Sweden AB",
        normalized: normalizeName("Volvo Group Sweden AB").core,
        isCustomer: true,
      },
    });
    customerId = c.id;
  });

  const lines = () => [
    { accountCode: "100", debit: 1000, credit: 0, description: "kasa girişi" },
    { accountCode: "500", debit: 0, credit: 1000, description: "sermaye" },
  ];

  describe("fiş yazma", () => {
    it("denk fiş numaralanarak kaydedilir", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "Açılış",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      expect(r.documentNo).toBe("YEV2026000001");
      expect(await db.journalLine.count()).toBe(2);
    });

    it("DENK OLMAYAN FİŞ KAYDEDİLEMEZ VE HİÇBİR İZ BIRAKMAZ", async () => {
      await expect(
        journal.post({
          entryDate: d("2026-06-15"),
          description: "Bozuk",
          sourceKind: "manual",
          lines: [
            { accountCode: "100", debit: 1000, credit: 0, description: "a" },
            { accountCode: "500", debit: 0, credit: 900, description: "b" },
          ],
          userId: USER,
        }),
      ).rejects.toThrow(/DENK DEĞİL/);
      expect(await db.journalEntry.count()).toBe(0);
    });

    it("DOĞRUDAN SQL İLE DENKSİZ FİŞ YAZILAMAZ", async () => {
      // Uygulama kontrolü tek savunma değildir: bir betik ya da düzeltme
      // sorgusu mizanı sessizce bozabilirdi.
      await expect(
        db.$executeRawUnsafe(`
          INSERT INTO "journal_entries"
            ("id","document_no","entry_date","description","source_kind","status",
             "total_debit","total_credit","created_by","created_at")
          VALUES (gen_random_uuid(),'X1',DATE '2026-06-15','x','manual','posted',
                  100, 90, '${USER}', NOW())`),
      ).rejects.toThrow();
    });

    it("SATIRLAR BAŞLIKLA UYUŞMAZSA REDDEDİLİR", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "Açılış",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      const entry = await db.journalEntry.findUniqueOrThrow({
        where: { documentNo: r.documentNo },
      });
      await expect(
        db.$executeRawUnsafe(`
          INSERT INTO "journal_lines" ("id","entry_id","line_no","account_code","debit","credit","description")
          VALUES (gen_random_uuid(),'${entry.id}',3,'100',50,0,'kaçak satır')`),
      ).rejects.toThrow(/denk değil|uyuşmuyor/);
    });

    it("KESİLEN FİŞ DEĞİŞTİRİLEMEZ VE SİLİNEMEZ", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "Açılış",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "journal_entries" SET "total_debit"=1, "total_credit"=1 WHERE "document_no"='${r.documentNo}'`,
        ),
      ).rejects.toThrow(/değiştirilemez/);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "journal_entries" WHERE "document_no"='${r.documentNo}'`),
      ).rejects.toThrow(/silinemez/);
    });

    it("plan dışı hesaba kayıt atılamaz", async () => {
      await expect(
        journal.post({
          entryDate: d("2026-06-15"),
          description: "x",
          sourceKind: "manual",
          lines: [
            { accountCode: "999", debit: 10, credit: 0, description: "a" },
            { accountCode: "500", debit: 0, credit: 10, description: "b" },
          ],
          userId: USER,
        }),
      ).rejects.toThrow(/Tek Düzen Hesap Planı/);
    });

    it("KAPALI DÖNEME FİŞ YAZILAMAZ", async () => {
      await db.accountingPeriod.create({
        data: { year: 2026, month: 5, status: "closed", closedAt: new Date() },
      });
      await expect(
        journal.post({
          entryDate: d("2026-05-20"),
          description: "x",
          sourceKind: "manual",
          lines: lines(),
          userId: USER,
        }),
      ).rejects.toThrow(/Mayıs 2026 dönemi kapalı/);
    });
  });

  describe("ters kayıt", () => {
    it("FİŞ SİLİNMEZ, TERSİ YAZILIR VE BAĞLANIR", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "Açılış",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      const rev = await journal.reverse(r.documentNo, USER, "Yanlış hesaba yazıldı", d("2026-06-16"));

      const original = await db.journalEntry.findUniqueOrThrow({
        where: { documentNo: r.documentNo },
      });
      const reversal = await db.journalEntry.findUniqueOrThrow({
        where: { documentNo: rev.documentNo },
        include: { lines: true },
      });

      expect(original.status).toBe("reversed");
      expect(original.reversedBy).toBe(reversal.id);
      expect(reversal.reversalOf).toBe(original.id);

      // Taraflar değişmiş, tutar negatiflenmemiş.
      const kasa = reversal.lines.find((l) => l.accountCode === "100")!;
      expect(Number(kasa.credit)).toBe(1000);
      expect(Number(kasa.debit)).toBe(0);
    });

    it("TERS KAYIT MİZANI SIFIRLAR", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "Açılış",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      await journal.reverse(r.documentNo, USER, "hatalı kayıt", d("2026-06-16"));

      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      expect(tb.balanced).toBe(true);
      expect(tb.rows.find((x) => x.accountCode === "100")!.balance).toBe(0);
    });

    it("aynı fiş iki kez ters kaydedilemez", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "x",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      await journal.reverse(r.documentNo, USER, "hatalı kayıt", d("2026-06-16"));
      await expect(
        journal.reverse(r.documentNo, USER, "yine hatalı", d("2026-06-17")),
      ).rejects.toThrow(/reversed durumunda/);
    });

    it("gerekçesiz ters kayıt atılamaz", async () => {
      const r = await journal.post({
        entryDate: d("2026-06-15"),
        description: "x",
        sourceKind: "manual",
        lines: lines(),
        userId: USER,
      });
      await expect(journal.reverse(r.documentNo, USER, "yok", d("2026-06-16"))).rejects.toThrow(
        /gerekçesi/,
      );
    });
  });

  describe("belge → muhasebe", () => {
    async function fullCycle() {
      // Stok girişi (satıcılı → muhasebeleşir)
      const supplier = await db.partner.create({
        data: {
          code: "T-0001",
          legalName: "Burçelik A.Ş.",
          normalized: normalizeName("Burçelik A.Ş.").core,
          isSupplier: true,
        },
      });
      await valuation.postReceipt({
        itemId: "MM-500",
        locationId: "DEPO-1",
        quantity: 100,
        unitCost: 500,
        at: d("2026-06-10"),
        userId: USER,
        referenceId: "MK-1",
        partnerId: supplier.id,
        vatAmount: 10_000,
      });

      await db.salesOrder.create({
        data: {
          orderNo: "SO-1",
          partnerId: customerId,
          committedDate: d("2026-06-30"),
          lines: {
            create: [
              { lineNo: 1, itemId: "MM-500", uom: "adet", quantity: 100, unitPrice: 900, vatRate: 20 },
            ],
          },
        },
      });

      const del = await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: d("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });
      const delivery = await db.delivery.findUniqueOrThrow({
        where: { documentNo: del.documentNo },
      });

      const inv = await sales.issueInvoice({
        sources: [{ deliveryId: delivery.id, deliveryLineNo: 1 }],
        issuedAt: d("2026-06-25"),
        userId: USER,
      });
      return { inv, supplier };
    }

    it("MAL KABULÜ 150/191/320 YAZAR", async () => {
      const { supplier } = await fullCycle();
      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      // 100 × 500 = 50.000 stok, 10.000 KDV, 60.000 satıcı borcu
      expect(tb.rows.find((r) => r.accountCode === "191")!.debit).toBe(10_000);
      expect(tb.rows.find((r) => r.accountCode === "320")!.credit).toBe(60_000);
      expect(supplier.id).toBeTruthy();
    });

    it("SEVKİYAT MALİYETİ 620/152 YAZAR — satışla aynı dönemde", async () => {
      await fullCycle();
      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      // 10 adet × 500 TL = 5.000 maliyet
      expect(tb.rows.find((r) => r.accountCode === "620")!.debit).toBe(5_000);
    });

    it("FATURA 120/600/391 YAZAR — KDV ciroya karışmaz", async () => {
      await fullCycle();
      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      // 10 × 900 = 9.000 matrah, 1.800 KDV, 10.800 toplam
      expect(tb.rows.find((r) => r.accountCode === "120")!.debit).toBe(10_800);
      expect(tb.rows.find((r) => r.accountCode === "600")!.credit).toBe(9_000);
      expect(tb.rows.find((r) => r.accountCode === "391")!.credit).toBe(1_800);
    });

    it("TÜM ZİNCİR SONUNDA MİZAN DENKTİR", async () => {
      await fullCycle();
      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebit).toBe(tb.totalCredit);
    });

    it("GERÇEK KÂR HESAPLANIR — gelir eksi maliyet", async () => {
      await fullCycle();
      const s = await journal.income(d("2026-06-01"), d("2026-06-30"));
      expect(s.revenue).toBe(9_000);
      expect(s.cogs).toBe(5_000);
      expect(s.grossProfit).toBe(4_000);
    });

    it("AYNI BELGE İKİ KEZ MUHASEBELEŞEMEZ", async () => {
      const { inv } = await fullCycle();
      const invoice = await db.salesInvoice.findUniqueOrThrow({
        where: { documentNo: inv.documentNo },
      });
      await expect(
        journal.post({
          entryDate: d("2026-06-25"),
          description: "kopya",
          sourceKind: "sales_invoice",
          sourceId: invoice.id,
          lines: lines(),
          userId: USER,
        }),
      ).rejects.toThrow(/zaten muhasebeleşmiş/);
    });

    it("faturanın fişi belgeden bulunabilir", async () => {
      const { inv } = await fullCycle();
      const invoice = await db.salesInvoice.findUniqueOrThrow({
        where: { documentNo: inv.documentNo },
      });
      const entry = await journal.entryFor("sales_invoice", invoice.id);
      expect(entry!.lines.map((l) => l.accountCode).sort()).toEqual(["120", "391", "600"]);
      expect(entry!.lines[0]!.accountName).toBe("Alıcılar");
    });

    it("ÖDEME CARİYİ KAPATIR", async () => {
      await db.invoice.create({
        data: {
          id: "FTR-A",
          partnerId: "p-x",
          documentNo: "FTR-A",
          issuedAt: d("2026-06-10"),
          currency: "TRY",
          matchStatus: "matched",
          lines: { create: [{ lineNo: 1, itemId: "MM-500", quantity: 1, unitPrice: 5_000, currency: "TRY" }] },
        },
      });
      await procurement.postPayment({
        direction: "outgoing",
        partnerId: "p-x",
        amount: 5_000,
        method: "havale",
        paidAt: d("2026-06-22"),
        userId: USER,
        allocations: [{ invoiceNo: "FTR-A", amount: 5_000 }],
      });

      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      expect(tb.rows.find((r) => r.accountCode === "320")!.debit).toBe(5_000);
      expect(tb.rows.find((r) => r.accountCode === "102")!.credit).toBe(5_000);
      expect(tb.balanced).toBe(true);
    });
  });

  describe("cari ekstre ve yaşlandırma", () => {
    it("BAKİYE SATIR SATIR YÜRÜR", async () => {
      await journal.post({
        entryDate: d("2026-06-10"),
        description: "Fatura",
        sourceKind: "manual",
        lines: [
          { accountCode: "120", debit: 10_000, credit: 0, description: "F1", partnerId: customerId },
          { accountCode: "600", debit: 0, credit: 10_000, description: "F1" },
        ],
        userId: USER,
      });
      await journal.post({
        entryDate: d("2026-06-20"),
        description: "Tahsilat",
        sourceKind: "manual",
        lines: [
          { accountCode: "102", debit: 4_000, credit: 0, description: "T1" },
          { accountCode: "120", debit: 0, credit: 4_000, description: "T1", partnerId: customerId },
        ],
        userId: USER,
      });

      const st = await journal.partnerStatement(customerId, d("2026-06-01"), d("2026-06-30"));
      expect(st.openingBalance).toBe(0);
      expect(st.movements.map((m) => m.balance)).toEqual([10_000, 6_000]);
      expect(st.closingBalance).toBe(6_000);
    });

    it("AÇILIŞ BAKİYESİ ÖNCEKİ DÖNEMDEN TAŞINIR", async () => {
      await journal.post({
        entryDate: d("2026-05-10"),
        description: "Eski fatura",
        sourceKind: "manual",
        lines: [
          { accountCode: "120", debit: 2_500, credit: 0, description: "F0", partnerId: customerId },
          { accountCode: "600", debit: 0, credit: 2_500, description: "F0" },
        ],
        userId: USER,
      });
      const st = await journal.partnerStatement(customerId, d("2026-06-01"), d("2026-06-30"));
      expect(st.openingBalance).toBe(2_500);
      expect(st.movements).toEqual([]);
      expect(st.closingBalance).toBe(2_500);
    });

    it("YAŞLANDIRMA KOVALARA AYIRIR — tek toplam karar verdirmez", async () => {
      await journal.post({
        entryDate: d("2026-03-01"),
        description: "Eski",
        sourceKind: "manual",
        lines: [
          { accountCode: "120", debit: 5_000, credit: 0, description: "F-eski", partnerId: customerId },
          { accountCode: "600", debit: 0, credit: 5_000, description: "F-eski" },
        ],
        userId: USER,
      });
      await journal.post({
        entryDate: d("2026-06-10"),
        description: "Yeni",
        sourceKind: "manual",
        lines: [
          { accountCode: "120", debit: 3_000, credit: 0, description: "F-yeni", partnerId: customerId },
          { accountCode: "600", debit: 0, credit: 3_000, description: "F-yeni" },
        ],
        userId: USER,
      });

      const aging = await journal.receivablesAging(d("2026-06-20"));
      const row = aging.find((a) => a.partnerId === customerId)!;
      expect(row.balance).toBe(8_000);
      expect(row.current).toBe(3_000);
      expect(row.over90).toBe(5_000);
    });

    it("TAHSİLAT YAŞLANDIRILMAZ — tahsilatın yaşı olmaz", async () => {
      await journal.post({
        entryDate: d("2026-06-10"),
        description: "Fatura",
        sourceKind: "manual",
        lines: [
          { accountCode: "120", debit: 10_000, credit: 0, description: "F1", partnerId: customerId },
          { accountCode: "600", debit: 0, credit: 10_000, description: "F1" },
        ],
        userId: USER,
      });
      await journal.post({
        entryDate: d("2026-06-20"),
        description: "Tahsilat",
        sourceKind: "manual",
        lines: [
          { accountCode: "102", debit: 10_000, credit: 0, description: "T1" },
          { accountCode: "120", debit: 0, credit: 10_000, description: "T1", partnerId: customerId },
        ],
        userId: USER,
      });
      // Bakiye sıfır → listede görünmez.
      expect(await journal.receivablesAging(d("2026-06-25"))).toEqual([]);
    });
  });
});
