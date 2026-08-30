/**
 * Satış iadesi ve dekontlar.
 *
 * KESİLMİŞ FATURA İPTAL EDİLMEZ, İADE EDİLİR. Testler bu ayrımın
 * mali sonuçlarını sınıyor: iade 610'a yazılır (600 ters yazılmaz),
 * KDV düzeltilir, stok geri girer ve faturalanandan fazlası iade
 * edilemez.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { CreditNoteRepository, CreditNoteError, accountFor } from "../src/db/credit-note-repository.js";
import { SalesRepository } from "../src/db/sales-repository.js";
import { JournalRepository } from "../src/db/journal-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_credit";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe("hesap eşlemesi", () => {
  it("HER TÜR AYRI HESABA YAZILIR", () => {
    // 600 ters yazılsaydı ciro düşer ve "bu yıl ne sattık" bozulurdu.
    expect(accountFor("iade")).toBe("610");
    expect(accountFor("alacak_dekontu")).toBe("611");
    expect(accountFor("borc_dekontu")).toBe("600");
  });
});

describe.skipIf(!enabled)("iade ve dekont kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: CreditNoteRepository;
  let sales: SalesRepository;
  let journal: JournalRepository;
  let partnerId: string;
  let deliveryId: string;
  let invoiceNo: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new CreditNoteRepository(db);
    sales = new SalesRepository(db);
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
    for (const t of [
      "sales_credit_note_lines",
      "sales_credit_notes",
      "sales_invoice_lines",
      "sales_invoices",
      "delivery_lines",
      "deliveries",
      "sales_order_lines",
      "sales_orders",
      "journal_lines",
      "journal_entries",
      "stock_movements",
      "document_number_ranges",
      "partners",
      "items",
    ]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
      await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }

    const p = await db.partner.create({
      data: {
        code: "M-1",
        legalName: "Daimler A.Ş.",
        normalized: normalizeName("Daimler A.Ş.").core,
        isCustomer: true,
      },
    });
    partnerId = p.id;
    await db.item.create({
      data: { code: "M-1001", name: "Profil", normalized: "profil", type: "mamul", baseUom: "adet" },
    });
    await db.salesOrder.create({
      data: {
        orderNo: "SO-1",
        partnerId,
        committedDate: new Date("2026-06-30"),
        lines: {
          create: [
            { lineNo: 1, itemId: "M-1001", uom: "adet", quantity: 100, unitPrice: 250, vatRate: 20 },
          ],
        },
      },
    });
    const d = await sales.postDelivery({
      orderNo: "SO-1",
      locationId: "DEPO-1",
      shippedAt: new Date("2026-06-10"),
      userId: USER,
      lines: [{ orderLineNo: 1, quantity: 100 }],
    });
    deliveryId = (await db.delivery.findUniqueOrThrow({ where: { documentNo: d.documentNo } })).id;
    const inv = await sales.issueInvoice({
      sources: [{ deliveryId, deliveryLineNo: 1 }],
      issuedAt: new Date("2026-06-15"),
      userId: USER,
    });
    invoiceNo = inv.documentNo;
  });

  it("iade kesilir ve 610'a yazılır", async () => {
    const n = await repo.issue({
      kind: "iade",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Müşteri hasarlı teslim aldı",
      withGoods: true,
      locationId: "DEPO-1",
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 10 }],
    });

    expect(n.netAmount).toBe(2_500);
    expect(n.vatAmount).toBe(500);
    expect(n.totalAmount).toBe(3_000);
    expect(n.documentNo).toMatch(/^IAD/);

    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: n.journalDocumentNo! },
      include: { lines: true },
    });
    expect(Number(entry.lines.find((l) => l.accountCode === "610")?.debit)).toBe(2_500);
    // KDV DÜZELTİLİR: iade edilen malın KDV'si beyandan düşülür.
    expect(Number(entry.lines.find((l) => l.accountCode === "391")?.debit)).toBe(500);
    // Cari ALACAKLANIR: müşterinin borcu azalır.
    expect(Number(entry.lines.find((l) => l.accountCode === "120")?.credit)).toBe(3_000);
    // 600 HİÇ KULLANILMAZ.
    expect(entry.lines.find((l) => l.accountCode === "600")).toBeUndefined();
  });

  it("MAL İADESİNDE STOK GERİ GİRER", async () => {
    await repo.issue({
      kind: "iade",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Hasarlı teslimat",
      withGoods: true,
      locationId: "DEPO-1",
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 10 }],
    });
    const mv = await db.stockMovement.findFirstOrThrow({
      where: { movementType: "satis_iadesi" },
    });
    expect(mv.direction).toBe(1);
    expect(Number(mv.quantity)).toBe(10);
  });

  it("ALACAK DEKONTUNDA STOK HAREKETİ OLMAZ", async () => {
    // Fiyat düzeltmesi malın yerini değiştirmez; yazılsaydı depoda
    // olmayan mal görünürdü.
    await repo.issue({
      kind: "alacak_dekontu",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Fiyat farkı düzeltmesi",
      withGoods: false,
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 100, unitPrice: 10 }],
    });
    const mv = await db.stockMovement.findFirst({ where: { movementType: "satis_iadesi" } });
    expect(mv).toBeNull();
  });

  it("alacak dekontu 611'e yazılır", async () => {
    const n = await repo.issue({
      kind: "alacak_dekontu",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Toplu alım iskontosu",
      withGoods: false,
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 100, unitPrice: 10 }],
    });
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: n.journalDocumentNo! },
      include: { lines: true },
    });
    expect(Number(entry.lines.find((l) => l.accountCode === "611")?.debit)).toBe(1_000);
  });

  it("BORÇ DEKONTU CARİYİ BORÇLANDIRIR — ters yönde", async () => {
    const n = await repo.issue({
      kind: "borc_dekontu",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Nakliye masrafı yansıtması",
      withGoods: false,
      userId: USER,
      lines: [{ invoiceLineNo: null, quantity: 1, unitPrice: 5_000, description: "Nakliye" }],
    });
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { documentNo: n.journalDocumentNo! },
      include: { lines: true },
    });
    expect(Number(entry.lines.find((l) => l.accountCode === "120")?.debit)).toBe(6_000);
    expect(Number(entry.lines.find((l) => l.accountCode === "600")?.credit)).toBe(5_000);
    expect(Number(entry.lines.find((l) => l.accountCode === "391")?.credit)).toBe(1_000);
  });

  it("FATURALANANDAN FAZLA İADE EDİLEMEZ", async () => {
    // Edilebilseydi cari bakiyesi alacaklı çıkar, müşteriye borçlu görünürdük.
    await expect(
      repo.issue({
        kind: "iade",
        invoiceNo,
        issuedAt: new Date("2026-06-20"),
        reason: "Tamamı geri geldi ve fazlası",
        withGoods: true,
        locationId: "DEPO-1",
        userId: USER,
        lines: [{ invoiceLineNo: 1, quantity: 101 }],
      }),
    ).rejects.toThrow(/en fazla 100/);
  });

  it("İKİ İADE BİRLİKTE DE SINIRI AŞAMAZ", async () => {
    await repo.issue({
      kind: "iade",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Birinci parti iade",
      withGoods: true,
      locationId: "DEPO-1",
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 60 }],
    });
    await expect(
      repo.issue({
        kind: "iade",
        invoiceNo,
        issuedAt: new Date("2026-06-21"),
        reason: "İkinci parti iade",
        withGoods: true,
        locationId: "DEPO-1",
        userId: USER,
        lines: [{ invoiceLineNo: 1, quantity: 50 }],
      }),
    ).rejects.toThrow(/daha önce iade 60/);
  });

  it("İADE FATURA SATIRINA BAĞLANMALIDIR", async () => {
    await expect(
      repo.issue({
        kind: "iade",
        invoiceNo,
        issuedAt: new Date("2026-06-20"),
        reason: "Bağlantısız iade denemesi",
        withGoods: true,
        locationId: "DEPO-1",
        userId: USER,
        lines: [{ invoiceLineNo: null, quantity: 5, unitPrice: 100 }],
      }),
    ).rejects.toThrow(/fatura satırına bağlanmalı/);
  });

  it("MAL İADESİNDE DEPO ZORUNLUDUR", async () => {
    await expect(
      repo.issue({
        kind: "iade",
        invoiceNo,
        issuedAt: new Date("2026-06-20"),
        reason: "Deposuz iade denemesi",
        withGoods: true,
        userId: USER,
        lines: [{ invoiceLineNo: 1, quantity: 5 }],
      }),
    ).rejects.toThrow(CreditNoteError);
  });

  it("GEREKÇESİZ İADE KESİLMEZ", async () => {
    await expect(
      repo.issue({
        kind: "iade",
        invoiceNo,
        issuedAt: new Date("2026-06-20"),
        reason: "yok",
        withGoods: true,
        locationId: "DEPO-1",
        userId: USER,
        lines: [{ invoiceLineNo: 1, quantity: 5 }],
      }),
    ).rejects.toThrow(/gerekçe/i);
  });

  it("iade kaydı MİZANI BOZMAZ", async () => {
    await repo.issue({
      kind: "iade",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Hasarlı ürün iadesi",
      withGoods: true,
      locationId: "DEPO-1",
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 10 }],
    });
    const tb = await journal.trialBalance(new Date("2026-01-01"), new Date("2026-12-31"));
    expect(tb.balanced).toBe(true);
  });

  it("faturanın iadeleri listelenir ve NET AZALMA hesaplanır", async () => {
    await repo.issue({
      kind: "iade",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Hasarlı ürün iadesi",
      withGoods: true,
      locationId: "DEPO-1",
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 10 }],
    });
    const rows = await repo.listForInvoice(invoiceNo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalAmount).toBe(3_000);
  });

  it("KESİLMİŞ DEKONT SİLİNEMEZ", async () => {
    await repo.issue({
      kind: "iade",
      invoiceNo,
      issuedAt: new Date("2026-06-20"),
      reason: "Hasarlı ürün iadesi",
      withGoods: true,
      locationId: "DEPO-1",
      userId: USER,
      lines: [{ invoiceLineNo: 1, quantity: 10 }],
    });
    await expect(db.$executeRawUnsafe(`DELETE FROM "sales_credit_notes"`)).rejects.toThrow(
      /silinemez/,
    );
  });

  it("TASLAK FATURAYA İADE YAPILAMAZ", async () => {
    const draft = await db.salesInvoice.create({
      data: {
        documentNo: "FTR-TASLAK",
        partnerId,
        issuedAt: new Date("2026-06-01"),
        netAmount: 100,
        vatAmount: 20,
        totalAmount: 120,
        status: "draft",
      },
    });
    expect(draft.status).toBe("draft");
    await expect(
      repo.issue({
        kind: "iade",
        invoiceNo: "FTR-TASLAK",
        issuedAt: new Date("2026-06-20"),
        reason: "Taslak faturaya iade denemesi",
        withGoods: false,
        userId: USER,
        lines: [{ invoiceLineNo: 1, quantity: 1, unitPrice: 10 }],
      }),
    ).rejects.toThrow(/kesilmemiş/);
  });
});
