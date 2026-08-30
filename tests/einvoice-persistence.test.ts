/**
 * e-Fatura belgesi — gerçek fatura verisinden.
 *
 * Bu dosyanın asıl işi, EKSİK VERİYLE BELGE ÜRETİLMEDİĞİNİ kanıtlamaktır.
 * Geçersiz bir UBL'yi entegratöre gönderip oradan dönen hatayı çözmeye
 * çalışmak, kullanıcıyı kendi sisteminde göremediği bir sorunla baş başa
 * bırakır.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { EInvoiceRepository } from "../src/db/einvoice-repository.js";
import { SalesRepository } from "../src/db/sales-repository.js";
import { ValuationRepository } from "../src/db/valuation-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_efatura";
const USER = "00000000-0000-0000-0000-0000000000aa";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe.skipIf(!enabled)("e-Fatura kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: EInvoiceRepository;
  let sales: SalesRepository;
  let valuation: ValuationRepository;
  let customerId: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new EInvoiceRepository(db);
    sales = new SalesRepository(db);
    valuation = new ValuationRepository(db);
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
      await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
    await db.deliveryLine.deleteMany();
    await db.delivery.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.stockMovement.deleteMany();
    await db.itemCostState.deleteMany();
    await db.partnerTaxId.deleteMany();
    await db.partner.deleteMany();
    await db.itemUnit.deleteMany();
    await db.item.deleteMany();
    await db.documentNumberRange.deleteMany();
    await db.companyProfile.deleteMany();

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
        taxOffice: "Beşiktaş",
        addressLine: "Levent Mahallesi 5. Sokak No:3",
        district: "Beşiktaş",
        city: "İstanbul",
        einvoiceUser: true,
        taxIds: { create: [{ kind: "vkn", value: "1000000018" }] },
      },
    });
    customerId = c.id;
  });

  const company = () =>
    repo.saveCompanyProfile({
      legalName: "Orthaus Makina Sanayi A.Ş.",
      taxId: "1234567890",
      taxOffice: "Nilüfer",
      addressLine: "Organize Sanayi Bölgesi 3. Cadde No:12",
      district: "Nilüfer",
      city: "Bursa",
    });

  async function issueInvoice() {
    await valuation.postReceipt({
      itemId: "MM-500",
      locationId: "DEPO-1",
      quantity: 100,
      unitCost: 500,
      at: d("2026-06-10"),
      userId: USER,
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
    return sales.issueInvoice({
      sources: [{ deliveryId: delivery.id, deliveryLineNo: 1 }],
      issuedAt: d("2026-06-25"),
      userId: USER,
    });
  }

  describe("hazırlık kontrolü", () => {
    it("eksiksiz cari hazırdır", async () => {
      await company();
      expect(await repo.readiness(customerId)).toEqual({ ready: true, missing: [] });
    });

    it("ŞİRKET KİMLİĞİ YOKSA HAZIR DEĞİLDİR", async () => {
      const r = await repo.readiness(customerId);
      expect(r.ready).toBe(false);
      expect(r.missing[0]).toContain("Şirket kimliği");
    });

    it("EKSİK CARİ ALANLARI TEK TEK SAYILIR", async () => {
      await company();
      await db.partner.update({
        where: { id: customerId },
        data: { taxOffice: null, city: null, einvoiceUser: null },
      });
      const r = await repo.readiness(customerId);
      expect(r.missing).toHaveLength(3);
      expect(r.missing.join(" ")).toContain("vergi dairesi");
      expect(r.missing.join(" ")).toContain("il");
      expect(r.missing.join(" ")).toContain("mükellefiyeti");
    });

    it("vergi numarası olmayan cari hazır değildir", async () => {
      await company();
      await db.partnerTaxId.deleteMany();
      const r = await repo.readiness(customerId);
      expect(r.missing).toContain("Alıcı: vergi/TC kimlik numarası");
    });
  });

  describe("belge üretimi", () => {
    it("kesilmiş faturadan UBL üretilir ve ETTN atanır", async () => {
      await company();
      const inv = await issueInvoice();
      const doc = await repo.buildFor(inv.documentNo);

      expect(doc.profile).toBe("TEMELFATURA");
      expect(doc.xml).toContain("<cbc:CustomizationID>TR1.2</cbc:CustomizationID>");
      expect(doc.xml).toContain('schemeID="VKN">1234567890');
      expect(doc.xml).toContain("Volvo Group Sweden AB");
      expect(doc.xml).toContain('<cbc:PayableAmount currencyID="TRY">10800.00</cbc:PayableAmount>');

      const stored = await db.salesInvoice.findUniqueOrThrow({
        where: { documentNo: inv.documentNo },
      });
      expect(stored.ettn).toBe(doc.ettn);
      expect(stored.einvoiceKind).toBe("e-fatura");
      expect(stored.einvoiceStatus).toBe("pending");
    });

    it("ETTN BİR KEZ ÜRETİLİR — ikinci çağrı aynısını verir", async () => {
      // Yeniden üretilseydi aynı fatura için iki farklı belge çıkar ve
      // biri gönderildikten sonra diğeri "başka bir fatura" sayılırdı.
      await company();
      const inv = await issueInvoice();
      const first = await repo.buildFor(inv.documentNo);
      const second = await repo.buildFor(inv.documentNo);
      expect(second.ettn).toBe(first.ettn);
    });

    it("ETTN SONRADAN DEĞİŞTİRİLEMEZ — doğrudan SQL ile bile", async () => {
      // Değiştirilebilseydi, gönderilmiş bir belgenin kimliği sonradan
      // başka bir belgeye devredilebilirdi.
      await company();
      const inv = await issueInvoice();
      await repo.buildFor(inv.documentNo);
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "sales_invoices" SET "ettn" = '00000000-0000-0000-0000-000000000000'
             WHERE "document_no" = '${inv.documentNo}'`,
        ),
      ).rejects.toThrow(/ETTN değiştirilemez/);
    });

    it("KESİLMİŞ FATURANIN TUTARI HÂLÂ DEĞİŞTİRİLEMEZ", async () => {
      // Gönderim alanlarına izin vermek, mali içeriği açmamalı.
      await company();
      const inv = await issueInvoice();
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "sales_invoices" SET "total_amount" = 1 WHERE "document_no" = '${inv.documentNo}'`,
        ),
      ).rejects.toThrow(/içeriği değiştirilemez/);
    });

    it("KESİLMİŞ FATURA TASLAĞA DÖNEMEZ", async () => {
      await company();
      const inv = await issueInvoice();
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "sales_invoices" SET "status" = 'draft' WHERE "document_no" = '${inv.documentNo}'`,
        ),
      ).rejects.toThrow(/yalnızca iptal edilebilir/);
    });

    it("MÜKELLEF OLMAYANA e-ARŞİV ÜRETİLİR", async () => {
      await company();
      await db.partner.update({ where: { id: customerId }, data: { einvoiceUser: false } });
      const inv = await issueInvoice();
      const doc = await repo.buildFor(inv.documentNo);
      expect(doc.profile).toBe("EARSIVFATURA");
    });

    it("MÜKELLEFİYET BİLİNMİYORSA BELGE ÜRETİLMEZ", async () => {
      // Tahmin edilseydi, mükellef bir alıcıya e-Arşiv gönderilir ve
      // fatura geçersiz olurdu.
      await company();
      await db.partner.update({ where: { id: customerId }, data: { einvoiceUser: null } });
      const inv = await issueInvoice();
      await expect(repo.buildFor(inv.documentNo)).rejects.toThrow(/GİB'den/);
    });

    it("EKSİK ADRESLE BELGE ÜRETİLMEZ VE EKSİKLER SAYILIR", async () => {
      await company();
      await db.partner.update({ where: { id: customerId }, data: { addressLine: null } });
      const inv = await issueInvoice();
      await expect(repo.buildFor(inv.documentNo)).rejects.toThrow(/zorunlu alan eksik/);
      await expect(repo.buildFor(inv.documentNo)).rejects.toThrow(/Alıcı: adres/);
    });

    it("ŞİRKET KİMLİĞİ YOKSA BELGE ÜRETİLMEZ", async () => {
      const inv = await issueInvoice();
      await expect(repo.buildFor(inv.documentNo)).rejects.toThrow(/Şirket kimliği/);
    });

    it("olmayan fatura için belge üretilmez", async () => {
      await company();
      await expect(repo.buildFor("FTR-YOK")).rejects.toThrow(/bulunamadı/);
    });
  });

  describe("gönderim kuyruğu", () => {
    it("belgesi üretilmiş faturalar listelenir", async () => {
      await company();
      const inv = await issueInvoice();
      await repo.buildFor(inv.documentNo);

      const pending = await repo.pendingDocuments();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        documentNo: inv.documentNo,
        kind: "e-fatura",
        totalAmount: 10_800,
      });
    });

    it("BELGESİ ÜRETİLMEMİŞ FATURA KUYRUKTA GÖRÜNMEZ", async () => {
      await company();
      await issueInvoice();
      expect(await repo.pendingDocuments()).toEqual([]);
    });
  });
});
