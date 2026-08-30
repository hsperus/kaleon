/**
 * Parti izleme — gerçek Postgres'e karşı.
 *
 * Bu dosya tek bir senaryoyu sınar ve o senaryo bu modülün varlık
 * sebebidir: MÜŞTERİDEN ŞİKÂYET GELDİ. Bu partiden başka kime ne gitti,
 * ve bu parti neyden yapıldı? İki soruya da eksiksiz cevap verilemiyorsa
 * geri çağırma tüm üretime yayılır.
 *
 * BOŞ CEVAP "TEMİZ" DEĞİLDİR: bağ yazılmadığı için boş gelen bir izleme,
 * hiçbir yere gitmemiş bir partiyle aynı görünür. Aradaki farkın
 * söylendiğini de sınıyoruz.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { BatchRepository } from "../src/db/batch-repository.js";
import { SalesRepository } from "../src/db/sales-repository.js";
import { ValuationRepository } from "../src/db/valuation-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_batch";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!enabled)("parti izleme kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: BatchRepository;
  let sales: SalesRepository;
  let valuation: ValuationRepository;
  let customerId: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new BatchRepository(db);
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
    // Yevmiye fişleri de temizlenir: kesilmiş fiş silinemediği için
    // tetikleyici geçici olarak kapatılır. Uygulama kodunun böyle bir
    // yolu YOKTUR ve olmamalıdır.
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "journal_lines"`);
    await db.$executeRawUnsafe(`DELETE FROM "journal_entries"`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
    await db.batchGenealogy.deleteMany();
    await db.batch.deleteMany();
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

    // Parti takipli hammadde ve mamul.
    await db.item.createMany({
      data: [
        {
          code: "HM-100",
          name: "Çelik Levha",
          normalized: "celik levha",
          type: "hammadde",
          baseUom: "kg",
          batchManaged: true,
          shelfLifeDays: 90,
        },
        {
          code: "MM-500",
          name: "Şasi Grubu",
          normalized: "sasi grubu",
          type: "mamul",
          baseUom: "adet",
          batchManaged: true,
        },
        {
          code: "SF-001",
          name: "Vida",
          normalized: "vida",
          type: "sarf",
          baseUom: "adet",
          batchManaged: false,
        },
      ],
    });

    const customer = await db.partner.create({
      data: {
        code: "M-0001",
        legalName: "Volvo Group Sweden AB",
        normalized: normalizeName("Volvo Group Sweden AB").core,
        isCustomer: true,
      },
    });
    customerId = customer.id;
  });

  describe("parti açma", () => {
    it("son kullanma tarihi RAF ÖMRÜNDEN hesaplanır", async () => {
      const b = await repo.create({
        itemCode: "HM-100",
        batchNo: "L-2026-A",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      expect(b.expiryDate).toBe("2026-08-30"); // +90 gün
    });

    it("RAF ÖMRÜ YOKSA TARİH DE YOK — 'sonsuz' yazılmaz", async () => {
      const b = await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-01"),
      });
      expect(b.expiryDate).toBe(null);
    });

    it("PARTİ TAKİPSİZ MALZEMEYE PARTİ AÇILMAZ", async () => {
      await expect(
        repo.create({
          itemCode: "SF-001",
          batchNo: "X-1",
          origin: "satin_alma",
          producedAt: new Date("2026-06-01"),
        }),
      ).rejects.toThrow(/parti takipli değil/);
    });

    it("aynı malzemede aynı parti iki kez açılamaz", async () => {
      await repo.create({
        itemCode: "HM-100",
        batchNo: "L-1",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      await expect(
        repo.create({
          itemCode: "HM-100",
          batchNo: "L-1",
          origin: "satin_alma",
          producedAt: new Date("2026-06-02"),
        }),
      ).rejects.toThrow(/zaten var/);
    });

    it("FARKLI MALZEMELER AYNI PARTİ NUMARASINI TAŞIYABİLİR", async () => {
      // Tedarikçiler kendi numaralarını verir; global benzersizlik
      // dayatmak gerçek numarayı değiştirmeye zorlardı.
      await repo.create({
        itemCode: "HM-100",
        batchNo: "L-1",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      await expect(
        repo.create({
          itemCode: "MM-500",
          batchNo: "L-1",
          origin: "uretim",
          producedAt: new Date("2026-06-01"),
        }),
      ).resolves.toMatchObject({ batchNo: "L-1" });
    });
  });

  describe("sevkiyat kontrolü", () => {
    async function orderAndStock(batchNo: string | null) {
      await valuation.postReceipt({
        itemId: "MM-500",
        locationId: "DEPO-1",
        quantity: 100,
        unitCost: 500,
        at: new Date("2026-06-05"),
        userId: USER,
      });
      await db.salesOrder.create({
        data: {
          orderNo: "SO-1",
          partnerId: customerId,
          committedDate: new Date("2026-06-30"),
          lines: {
            create: [
              { lineNo: 1, itemId: "MM-500", uom: "adet", quantity: 100, unitPrice: 900, vatRate: 20 },
            ],
          },
        },
      });
      return sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10, batchId: batchNo }],
      });
    }

    it("BLOKE PARTİ SEVK EDİLEMEZ", async () => {
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-01"),
      });
      await repo.setStatus("MM-500", "P-1", "blocked");
      await expect(orderAndStock("P-1")).rejects.toThrow(/BLOKELİ/);
      expect(await db.delivery.count()).toBe(0);
    });

    it("KARANTİNADAKİ PARTİ SEVK EDİLEMEZ", async () => {
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-01"),
        status: "quarantine",
      });
      await expect(orderAndStock("P-1")).rejects.toThrow(/KARANTİNADA/);
    });

    it("SÜRESİ DOLMUŞ PARTİ SEVK EDİLEMEZ", async () => {
      await db.item.update({ where: { code: "MM-500" }, data: { shelfLifeDays: 5 } });
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-01"),
      });
      await expect(orderAndStock("P-1")).rejects.toThrow(/süresi dolmuş/);
    });

    it("KAYITSIZ PARTİ SEVK EDİLEMEZ — zincir orada kopar", async () => {
      await expect(orderAndStock("HAYALET-1")).rejects.toThrow(/sistemde yok/);
    });

    it("serbest parti sevk edilir ve numara yanmaz", async () => {
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-01"),
      });
      const d = await orderAndStock("P-1");
      expect(d.documentNo).toBe("IRS2026000001");
    });

    it("REDDEDİLEN SEVKİYAT NUMARA YAKMAZ", async () => {
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-01"),
      });
      await repo.setStatus("MM-500", "P-1", "blocked");
      await expect(orderAndStock("P-1")).rejects.toThrow();
      expect(await db.documentNumberRange.count({ where: { kind: "delivery" } })).toBe(0);
    });
  });

  describe("geri çağırma senaryosu", () => {
    /** HM-100/L-1 → MM-500/P-1 ve P-2; ikisi de müşteriye gitti. */
    async function buildChain() {
      await repo.create({
        itemCode: "HM-100",
        batchNo: "L-1",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
        supplierBatchNo: "BRC-99",
        supplierId: customerId,
      });
      for (const p of ["P-1", "P-2"]) {
        await repo.create({
          itemCode: "MM-500",
          batchNo: p,
          origin: "uretim",
          producedAt: new Date("2026-06-10"),
          workOrderId: `WO-${p}`,
        });
        await repo.linkGenealogy({
          outputItemCode: "MM-500",
          outputBatchNo: p,
          inputs: [{ itemCode: "HM-100", batchNo: "L-1", quantity: 250 }],
          workOrderId: `WO-${p}`,
          at: new Date("2026-06-10"),
        });
      }

      await valuation.postReceipt({
        itemId: "MM-500",
        locationId: "DEPO-1",
        quantity: 200,
        unitCost: 500,
        at: new Date("2026-06-11"),
        userId: USER,
      });
      await db.salesOrder.create({
        data: {
          orderNo: "SO-1",
          partnerId: customerId,
          committedDate: new Date("2026-06-30"),
          lines: {
            create: [
              { lineNo: 1, itemId: "MM-500", uom: "adet", quantity: 50, unitPrice: 900, vatRate: 20 },
              { lineNo: 2, itemId: "MM-500", uom: "adet", quantity: 50, unitPrice: 900, vatRate: 20 },
            ],
          },
        },
      });
      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [
          { orderLineNo: 1, quantity: 20, batchId: "P-1" },
          { orderLineNo: 2, quantity: 30, batchId: "P-2" },
        ],
      });
    }

    it("İLERİ İZLEME: hammadde partisinden MÜŞTERİYE kadar gider", async () => {
      await buildChain();
      const t = await repo.traceForward("HM-100", "L-1");

      // Hammadde müşteriye gitmez; mamulün içinde gider. Yalnızca
      // irsaliyeye bakılsaydı cevap BOŞ çıkardı.
      expect(t.derivedBatches.map((b) => b.batchNo).sort()).toEqual(["P-1", "P-2"]);
      expect(t.shipments).toHaveLength(2);
      expect(t.shipments.map((s) => s.viaBatch).sort()).toEqual(["P-1", "P-2"]);
      expect(t.shipments[0]!.customer).toBe("Volvo Group Sweden AB");
      expect(t.caveats).toEqual([]);
    });

    it("GERİ İZLEME: mamulden tedarikçi partisine kadar gider", async () => {
      await buildChain();
      const t = await repo.traceBackward("MM-500", "P-1");
      expect(t.sourceBatches.map((b) => b.batchNo)).toEqual(["L-1"]);
      expect(t.receipts[0]).toMatchObject({
        batchNo: "L-1",
        supplierBatchNo: "BRC-99",
        supplier: "Volvo Group Sweden AB",
      });
    });

    it("BAĞ YAZILMAMIŞSA 'TEMİZ' DENMEZ — fark söylenir", async () => {
      // Üretilmiş ama hiçbir girdiye bağlanmamış parti.
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-YETIM",
        origin: "uretim",
        producedAt: new Date("2026-06-10"),
      });
      const t = await repo.traceBackward("MM-500", "P-YETIM");
      expect(t.sourceBatches).toEqual([]);
      expect(t.caveats[0]).toContain("BU KAYITLARDAN BULUNAMAZ");
    });

    it("hiç kullanılmamış parti için de fark söylenir", async () => {
      await repo.create({
        itemCode: "HM-100",
        batchNo: "L-YENI",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      const t = await repo.traceForward("HM-100", "L-YENI");
      expect(t.shipments).toEqual([]);
      expect(t.caveats[0]).toContain("hâlâ depoda");
    });

    it("ÇOK KADEMELİ ZİNCİR SONUNA KADAR İZLENİR", async () => {
      await repo.create({
        itemCode: "HM-100",
        batchNo: "L-1",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      // HM-100/L-1 → MM-500/A → MM-500/B → MM-500/C
      for (const p of ["A", "B", "C"]) {
        await repo.create({
          itemCode: "MM-500",
          batchNo: p,
          origin: "uretim",
          producedAt: new Date("2026-06-10"),
        });
      }
      await repo.linkGenealogy({
        outputItemCode: "MM-500",
        outputBatchNo: "A",
        inputs: [{ itemCode: "HM-100", batchNo: "L-1", quantity: 100 }],
        at: new Date("2026-06-10"),
      });
      await repo.linkGenealogy({
        outputItemCode: "MM-500",
        outputBatchNo: "B",
        inputs: [{ itemCode: "MM-500", batchNo: "A", quantity: 50 }],
        at: new Date("2026-06-11"),
      });
      await repo.linkGenealogy({
        outputItemCode: "MM-500",
        outputBatchNo: "C",
        inputs: [{ itemCode: "MM-500", batchNo: "B", quantity: 25 }],
        at: new Date("2026-06-12"),
      });

      const fwd = await repo.traceForward("HM-100", "L-1");
      expect(fwd.derivedBatches.map((b) => `${b.batchNo}@${b.depth}`)).toEqual([
        "A@1",
        "B@2",
        "C@3",
      ]);

      const back = await repo.traceBackward("MM-500", "C");
      expect(back.sourceBatches.map((b) => b.batchNo)).toEqual(["B", "A", "L-1"]);
    });

    it("PARTİ KENDİNDEN DOĞAMAZ — veritabanı reddeder", async () => {
      await repo.create({
        itemCode: "MM-500",
        batchNo: "P-1",
        origin: "uretim",
        producedAt: new Date("2026-06-10"),
      });
      await expect(
        repo.linkGenealogy({
          outputItemCode: "MM-500",
          outputBatchNo: "P-1",
          inputs: [{ itemCode: "MM-500", batchNo: "P-1", quantity: 1 }],
          at: new Date("2026-06-10"),
        }),
      ).rejects.toThrow();
    });
  });

  describe("raf ömrü", () => {
    it("süresi yaklaşan partiler en acili başta listelenir", async () => {
      await db.item.update({ where: { code: "HM-100" }, data: { shelfLifeDays: 10 } });
      await repo.create({
        itemCode: "HM-100",
        batchNo: "YAKIN",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      await db.item.update({ where: { code: "HM-100" }, data: { shelfLifeDays: 40 } });
      await repo.create({
        itemCode: "HM-100",
        batchNo: "UZAK",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });

      await valuation.postReceipt({
        itemId: "HM-100",
        locationId: "DEPO-1",
        quantity: 100,
        unitCost: 10,
        at: new Date("2026-06-01"),
        userId: USER,
        batchId: "YAKIN",
      });
      await valuation.postReceipt({
        itemId: "HM-100",
        locationId: "DEPO-1",
        quantity: 100,
        unitCost: 10,
        at: new Date("2026-06-01"),
        userId: USER,
        batchId: "UZAK",
      });

      const rows = await repo.expiring(new Date("2026-06-05"), 45);
      expect(rows.map((r) => r.batchNo)).toEqual(["YAKIN", "UZAK"]);
      expect(rows[0]!.daysLeft).toBe(6);
    });

    it("TÜKENMİŞ PARTİ UYARI ÜRETMEZ — gürültü gerçek uyarıyı öldürür", async () => {
      await db.item.update({ where: { code: "HM-100" }, data: { shelfLifeDays: 10 } });
      await repo.create({
        itemCode: "HM-100",
        batchNo: "BITTI",
        origin: "satin_alma",
        producedAt: new Date("2026-06-01"),
      });
      // Giriş ve tam çıkış: bakiye sıfır.
      await valuation.postReceipt({
        itemId: "HM-100",
        locationId: "DEPO-1",
        quantity: 100,
        unitCost: 10,
        at: new Date("2026-06-01"),
        userId: USER,
        batchId: "BITTI",
      });
      await db.stockMovement.create({
        data: {
          at: new Date("2026-06-03"),
          itemId: "HM-100",
          locationId: "DEPO-1",
          batchId: "BITTI",
          quantity: 100,
          direction: -1,
          movementType: "sevkiyat",
          userId: USER,
        },
      });

      expect(await repo.expiring(new Date("2026-06-05"), 45)).toEqual([]);
    });
  });
});
