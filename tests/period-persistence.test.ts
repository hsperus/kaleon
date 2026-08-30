/**
 * Dönem kapama — gerçek Postgres'e karşı.
 *
 * Tek bir iddia: KAPALI AY GERÇEKTEN KAPALIDIR. Bir ERP'de en sinsi hata,
 * beyannamesi verilmiş bir aya sonradan giren kayıttır: rapor bugün bir
 * sayı, üç ay sonra başka bir sayı verir ve hangisinin doğru olduğunu
 * söyleyecek kimse kalmaz.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PeriodRepository } from "../src/db/period-repository.js";
import { ValuationRepository } from "../src/db/valuation-repository.js";
import { SalesRepository } from "../src/db/sales-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_period";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!enabled)("dönem kapama kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: PeriodRepository;
  let valuation: ValuationRepository;
  let sales: SalesRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new PeriodRepository(db);
    valuation = new ValuationRepository(db);
    sales = new SalesRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`ALTER TABLE "sales_invoice_lines" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "sales_invoices" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "sales_invoice_lines"`);
    await db.$executeRawUnsafe(`DELETE FROM "sales_invoices"`);
    await db.$executeRawUnsafe(`ALTER TABLE "sales_invoices" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "sales_invoice_lines" ENABLE TRIGGER USER`);
    // Yevmiye fişleri de temizlenir: kesilmiş fiş silinemediği için
    // tetikleyici geçici olarak kapatılır. Uygulama kodunun böyle bir
    // yolu YOKTUR ve olmamalıdır.
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "journal_lines"`);
    await db.$executeRawUnsafe(`DELETE FROM "journal_entries"`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
    await db.deliveryLine.deleteMany();
    await db.delivery.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.partner.deleteMany();
    await db.stockMovement.deleteMany();
    await db.itemCostState.deleteMany();
    await db.documentNumberRange.deleteMany();
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "accounting_periods"`);
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" ENABLE TRIGGER USER`);
  });

  const receipt = (at: string, qty = 100, cost = 50) =>
    valuation.postReceipt({
      itemId: "M-1001",
      locationId: "DEPO-1",
      quantity: qty,
      unitCost: cost,
      at: new Date(at),
      userId: USER,
    });

  async function orderWithStock() {
    const customer = await db.partner.create({
      data: {
        code: "M-0001",
        legalName: "Volvo Group Sweden AB",
        normalized: normalizeName("Volvo Group Sweden AB").core,
        isCustomer: true,
      },
    });
    await db.salesOrder.create({
      data: {
        orderNo: "SO-1",
        partnerId: customer.id,
        committedDate: new Date("2026-06-30"),
        lines: {
          create: [
            { lineNo: 1, itemId: "M-1001", uom: "adet", quantity: 100, unitPrice: 250, vatRate: 20 },
          ],
        },
      },
    });
  }

  describe("varsayılan durum", () => {
    it("KAYIT YOKSA DÖNEM AÇIKTIR — sistem kurulur kurulmaz kilitlenmez", async () => {
      const s = await repo.statusOf(new Date("2026-06-15"));
      expect(s.status).toBe("open");
      await expect(receipt("2026-06-15")).resolves.toMatchObject({ unitCost: 50 });
    });

    it("yıl listesi 12 ay döner, kaydı olmayanlar açık", async () => {
      const list = await repo.list(2026);
      expect(list).toHaveLength(12);
      expect(list.every((p) => p.status === "open")).toBe(true);
    });
  });

  describe("kapalı döneme yazma", () => {
    it("MAL KABULÜ KAPALI AYA GİREMEZ", async () => {
      await repo.close({ year: 2026, month: 5, userId: USER });
      await expect(receipt("2026-05-20")).rejects.toThrow(/Mayıs 2026 dönemi kapalı/);
      expect(await db.stockMovement.count()).toBe(0);
    });

    it("SEVKİYAT KAPALI AYA GİREMEZ VE NUMARA YAKMAZ", async () => {
      await receipt("2026-06-01");
      await orderWithStock();
      await repo.close({ year: 2026, month: 5, userId: USER, force: true });

      await expect(
        sales.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-05-20"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 10 }],
        }),
      ).rejects.toThrow(/Mayıs 2026 dönemi kapalı/);

      // Numara kontrolden ÖNCE alınsaydı seride delik kalırdı.
      expect(await db.documentNumberRange.count({ where: { kind: "delivery" } })).toBe(0);
      expect(await db.delivery.count()).toBe(0);
    });

    it("AÇIK AYA YAZMA ETKİLENMEZ", async () => {
      await repo.close({ year: 2026, month: 5, userId: USER });
      await expect(receipt("2026-06-15")).resolves.toBeTruthy();
    });

    it("KAPALI DÖNEM HERKESE KAPALIDIR — yetki değil tarih kuralı", async () => {
      // Depoda da CFO'da da aynı hata; kural izinle esnetilemez.
      await repo.close({ year: 2026, month: 5, userId: USER });
      await expect(receipt("2026-05-20")).rejects.toThrow(/kapalı/);
    });
  });

  describe("kapama engelleri", () => {
    it("MALİYETİ BİLİNMEYEN HAREKET KAPAMAYI ENGELLER", async () => {
      await orderWithStock();
      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });

      const res = await repo.close({ year: 2026, month: 6, userId: USER });
      expect(res.status).toBe("open");
      expect(res.blockers.map((b) => b.kind)).toContain("unvalued_movements");
      expect(res.blockers.map((b) => b.kind)).toContain("uninvoiced_deliveries");
    });

    it("ENGEL VARKEN DÖNEM KAPANMAZ — sessizce geçilmez", async () => {
      await orderWithStock();
      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });
      const res = await repo.close({ year: 2026, month: 6, userId: USER });
      expect(res.status).toBe("open");
      expect((await repo.statusOf(new Date("2026-06-15"))).status).toBe("open");
      // Kapanmadıysa yazma hâlâ mümkün olmalı.
      await expect(receipt("2026-06-25")).resolves.toBeTruthy();
    });

    it("force ile kapatılır ama engeller kayda geçer", async () => {
      await orderWithStock();
      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });
      const res = await repo.close({ year: 2026, month: 6, userId: USER, force: true });
      expect(res.status).toBe("closed");
      expect(res.blockers.length).toBeGreaterThan(0);
      await expect(receipt("2026-06-25")).rejects.toThrow(/kapalı/);
    });

    it("ÖNCEKİ DÖNEM AÇIKKEN SONRAKİ KAPATILAMAZ", async () => {
      await repo.close({ year: 2026, month: 4, userId: USER });
      await repo.reopen({ year: 2026, month: 4, userId: USER, reason: "düzeltme kaydı gerekti" });
      const res = await repo.close({ year: 2026, month: 5, userId: USER });
      expect(res.blockers.map((b) => b.kind)).toContain("previous_period_open");
    });

    it("temiz dönem engelsiz kapanır", async () => {
      const res = await repo.close({ year: 2026, month: 6, userId: USER });
      expect(res.status).toBe("closed");
      expect(res.blockers).toEqual([]);
    });
  });

  describe("yeniden açma ve kilit", () => {
    it("SEBEPSİZ AÇILAMAZ", async () => {
      await repo.close({ year: 2026, month: 5, userId: USER });
      await expect(
        repo.reopen({ year: 2026, month: 5, userId: USER, reason: "x" }),
      ).rejects.toThrow(/sebebi yazılmalıdır/);
    });

    it("açma sebebi KALICI OLARAK kaydedilir", async () => {
      await repo.close({ year: 2026, month: 5, userId: USER });
      await repo.reopen({
        year: 2026,
        month: 5,
        userId: USER,
        reason: "Eksik sevkiyat faturası bulundu",
      });
      const row = await db.accountingPeriod.findUniqueOrThrow({
        where: { year_month: { year: 2026, month: 5 } },
      });
      expect(row.status).toBe("open");
      expect(row.reopenReason).toBe("Eksik sevkiyat faturası bulundu");
      expect(row.reopenedBy).toBe(USER);
      await expect(receipt("2026-05-20")).resolves.toBeTruthy();
    });

    it("açık dönem tekrar açılamaz", async () => {
      await expect(
        repo.reopen({ year: 2026, month: 5, userId: USER, reason: "sebep yazısı" }),
      ).rejects.toThrow(/zaten açık/);
    });

    it("KİLİTLİ DÖNEM AÇILAMAZ — veritabanı seviyesinde", async () => {
      await repo.close({ year: 2026, month: 5, userId: USER });
      await repo.lock(2026, 5);
      await expect(
        repo.reopen({ year: 2026, month: 5, userId: USER, reason: "yıl sonu düzeltmesi" }),
      ).rejects.toThrow(/Kilitli/);
      // Doğrudan SQL ile bile.
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "accounting_periods" SET "status" = 'open', "updated_at" = NOW()
            WHERE "year" = 2026 AND "month" = 5`,
        ),
      ).rejects.toThrow(/Kilitli dönem açılamaz/);
    });

    it("kilitli döneme yazma mesajı kilitli olduğunu SÖYLER", async () => {
      await repo.close({ year: 2026, month: 5, userId: USER });
      await repo.lock(2026, 5);
      await expect(receipt("2026-05-20")).rejects.toThrow(/KİLİTLİ/);
    });

    it("dönem doğrudan kilitlenemez", async () => {
      await expect(repo.lock(2026, 7)).rejects.toThrow(/önce kapatılmalıdır/);
    });
  });
});
