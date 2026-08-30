/**
 * Satış zinciri — gerçek Postgres'e karşı.
 *
 * Bu dosyanın omurgası şudur: ZİNCİR KOPMAZ VE MİKTAR KAYBOLMAZ.
 * Saf birim testleri kuralların doğru yazıldığını gösterir; buradaki
 * testler kuralların EŞZAMANLILIK VE İŞLEM SINIRLARI altında da geçerli
 * kaldığını gösterir. Bir ERP'de en pahalı hatalar bu ikisinin arasında
 * doğar: kural doğrudur, ama iki isteğin arasında uygulanmamıştır.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { SalesRepository, nextDocumentNo } from "../src/db/sales-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { invokeTool } from "../src/kernel/invoke.js";
import { invokeConfirmed } from "./helpers/confirm.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import type { TenantContext } from "../src/kernel/types.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_sales";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!enabled)("satış zinciri kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: SalesRepository;
  let customerId: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new SalesRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    // KESİLMİŞ FATURA SİLİNEMEZ — tetikleyici bunu doğru şekilde engeller.
    // Test verisini temizlemek için tetikleyici geçici olarak kapatılır;
    // uygulama kodunun böyle bir yolu YOKTUR ve olmamalıdır.
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
    await db.stockMovement.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.partner.deleteMany();
    await db.documentNumberRange.deleteMany();

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

  /** 2 kalemli standart sipariş: 100 adet @250 ve 40 adet @1.000. */
  async function order(
    orderNo = "SO-1",
    opts: { tolerance?: number; price1?: number } = {},
  ) {
    return db.salesOrder.create({
      data: {
        orderNo,
        partnerId: customerId,
        committedDate: new Date("2026-06-30"),
        currency: "TRY",
        overDeliveryTolerance: opts.tolerance ?? 0,
        lines: {
          create: [
            {
              lineNo: 1,
              itemId: "M-1001",
              uom: "adet",
              quantity: 100,
              unitPrice: opts.price1 ?? 250,
              vatRate: 20,
            },
            { lineNo: 2, itemId: "M-1002", uom: "adet", quantity: 40, unitPrice: 1000, vatRate: 20 },
          ],
        },
      },
    });
  }

  const lineOf = async (orderNo: string, lineNo: number) =>
    db.salesOrderLine.findFirstOrThrow({
      where: { lineNo, salesOrder: { orderNo } },
    });

  describe("belge numarası", () => {
    it("seri kesintisiz ilerler", async () => {
      const nos: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        nos.push(await db.$transaction((tx) => nextDocumentNo(tx, "sales_invoice", 2026)));
      }
      expect(nos).toEqual([
        "FTR2026000001",
        "FTR2026000002",
        "FTR2026000003",
        "FTR2026000004",
        "FTR2026000005",
      ]);
    });

    it("EŞZAMANLI İSTEKLER AYNI NUMARAYI ALMAZ", async () => {
      const nos = await Promise.all(
        Array.from({ length: 12 }, () =>
          db.$transaction((tx) => nextDocumentNo(tx, "delivery", 2026)),
        ),
      );
      expect(new Set(nos).size).toBe(12);
    });

    it("YIL DÖNÜMÜNDE SERİ SIFIRLANIR", async () => {
      await db.$transaction((tx) => nextDocumentNo(tx, "sales_invoice", 2026));
      await db.$transaction((tx) => nextDocumentNo(tx, "sales_invoice", 2026));
      const first2027 = await db.$transaction((tx) => nextDocumentNo(tx, "sales_invoice", 2027));
      expect(first2027).toBe("FTR2027000001");
    });

    it("SAYAÇ GERİ ALINAMAZ — veritabanı seviyesinde", async () => {
      await db.$transaction((tx) => nextDocumentNo(tx, "sales_invoice", 2026));
      await db.$transaction((tx) => nextDocumentNo(tx, "sales_invoice", 2026));
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "document_number_ranges" SET "last_number" = 1, "updated_at" = NOW() WHERE "kind" = 'sales_invoice'`,
        ),
      ).rejects.toThrow(/geri alınamaz/);
    });

    it("BELGE YAZILAMAZSA NUMARA DA GERİ DÖNER", async () => {
      await db.$transaction((tx) => nextDocumentNo(tx, "delivery", 2026));
      await expect(
        db.$transaction(async (tx) => {
          await nextDocumentNo(tx, "delivery", 2026);
          throw new Error("belge yazılamadı");
        }),
      ).rejects.toThrow("belge yazılamadı");
      // Yanan numara olsaydı sıradaki 3 olurdu; seride delik kalmaz.
      const next = await db.$transaction((tx) => nextDocumentNo(tx, "delivery", 2026));
      expect(next).toBe("IRS2026000002");
    });
  });

  describe("sevkiyat", () => {
    it("stok düşer, sipariş kalemi ilerler, durum türetilir", async () => {
      await order();
      const res = await repo.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 60 }],
      });

      expect(res.documentNo).toBe("IRS2026000001");
      expect(res.orderStatus).toBe("partially_delivered");

      const l1 = await lineOf("SO-1", 1);
      expect(Number(l1.deliveredQty)).toBe(60);

      const mv = await db.stockMovement.findFirstOrThrow({ where: { itemId: "M-1001" } });
      expect(mv.direction).toBe(-1);
      expect(Number(mv.quantity)).toBe(60);
      expect(mv.movementType).toBe("sevkiyat");
      expect(mv.referenceKind).toBe("delivery");
    });

    it("AŞIRI SEVKİYAT REDDEDİLİR VE HİÇBİR İZ BIRAKMAZ", async () => {
      await order();
      await expect(
        repo.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-20"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 101 }],
        }),
      ).rejects.toThrow(/aşırı sevkiyat kapalı/);

      // İşlem geri alındı: ne irsaliye, ne stok hareketi, ne de miktar.
      expect(await db.delivery.count()).toBe(0);
      expect(await db.stockMovement.count()).toBe(0);
      expect(Number((await lineOf("SO-1", 1)).deliveredQty)).toBe(0);
    });

    it("KISMİ SEVKİYATLAR BİRİKİR, TOPLAMDA SINIRI AŞAMAZ", async () => {
      await order();
      await repo.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-10"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 70 }],
      });
      await expect(
        repo.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-11"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 40 }],
        }),
      ).rejects.toThrow(/kalan 30 adet/);
    });

    it("AYNI KALEM TEK İRSALİYEDE İKİ KEZ YAZILAMAZ", async () => {
      await order();
      await expect(
        repo.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-10"),
          userId: USER,
          // Ayrı ayrı 60+60 kontrolü geçerdi; toplamda 120 adet sevk olurdu.
          lines: [
            { orderLineNo: 1, quantity: 60 },
            { orderLineNo: 1, quantity: 60 },
          ],
        }),
      ).rejects.toThrow(/iki kez geçiyor/);
      expect(await db.delivery.count()).toBe(0);
    });

    it("EŞZAMANLI İKİ SEVKİYAT TOPLAMDA SINIRI AŞAMAZ", async () => {
      await order();
      const results = await Promise.allSettled([
        repo.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-10"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 60 }],
        }),
        repo.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-10"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 60 }],
        }),
      ]);
      // İkisi de geçseydi 120 olurdu — sipariş 100. Kilit olmadan bu test
      // 120 görür: kural doğrudur ama iki okumanın arasında uygulanmamıştır.
      expect(Number((await lineOf("SO-1", 1)).deliveredQty)).toBe(60);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect((rejected as PromiseRejectedResult).reason.message).toMatch(/kalan 40 adet/);
      // Reddedilen sevkiyat hiçbir iz bırakmaz.
      expect(await db.delivery.count()).toBe(1);
      expect(await db.stockMovement.count()).toBe(1);
    });

    it("tolerans tanımlıysa o kadarına izin verir", async () => {
      await order("SO-T", { tolerance: 5 });
      await expect(
        repo.postDelivery({
          orderNo: "SO-T",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-10"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 105 }],
        }),
      ).resolves.toMatchObject({ documentNo: "IRS2026000001" });
      // 2. kalem hiç sevk edilmedi; sipariş bütün olarak kısmi kalır.
      expect(Number((await lineOf("SO-T", 1)).deliveredQty)).toBe(105);
      const view = await repo.orderByNo("SO-T");
      expect(view!.status).toBe("partially_delivered");
    });

    it("KAPANMIŞ SİPARİŞE SEVKİYAT YAPILAMAZ", async () => {
      const o = await order();
      await db.salesOrder.update({
        where: { id: o.id },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      await expect(
        repo.postDelivery({
          orderNo: "SO-1",
          locationId: "DEPO-1",
          shippedAt: new Date("2026-06-20"),
          userId: USER,
          lines: [{ orderLineNo: 1, quantity: 10 }],
        }),
      ).rejects.toThrow(/iptal edilmiş/);
    });
  });

  describe("sevkiyat iptali", () => {
    it("STOK HAREKETİ SİLİNMEZ, TERSİ YAZILIR", async () => {
      await order();
      const d = await repo.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 60 }],
      });

      const status = await repo.cancelDelivery(d.documentNo, USER, "Yanlış müşteriye yüklendi");
      expect(status).toBe("open");

      const movements = await db.stockMovement.findMany({ orderBy: { at: "asc" } });
      expect(movements).toHaveLength(2);
      expect(movements[1]!.direction).toBe(1);
      expect(movements[1]!.reversalOf).toBe(movements[0]!.id);
      expect(movements[1]!.reason).toBe("Yanlış müşteriye yüklendi");

      // Net bakiye etkisi sıfır.
      const net = movements.reduce((s, m) => s + m.direction * Number(m.quantity), 0);
      expect(net).toBe(0);
      expect(Number((await lineOf("SO-1", 1)).deliveredQty)).toBe(0);
    });

    it("aynı irsaliye iki kez iptal edilemez", async () => {
      await order();
      const d = await repo.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });
      await repo.cancelDelivery(d.documentNo, USER, "hata");
      await expect(repo.cancelDelivery(d.documentNo, USER, "hata")).rejects.toThrow(/cancelled/);
    });
  });

  describe("fatura", () => {
    async function deliver(qty: number, lineNo = 1) {
      const d = await repo.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: lineNo, quantity: qty }],
      });
      const row = await db.delivery.findUniqueOrThrow({ where: { documentNo: d.documentNo } });
      return row.id;
    }

    it("sevkiyattan fatura kesilir, tutar sipariş fiyatından hesaplanır", async () => {
      await order();
      const deliveryId = await deliver(60);

      const inv = await repo.issueInvoice({
        sources: [{ deliveryId, deliveryLineNo: 1 }],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });

      expect(inv.documentNo).toBe("FTR2026000001");
      // 60 × 250 = 15.000 net, %20 KDV = 3.000 → 18.000
      expect(inv.totalAmount).toBe(18_000);
      expect(inv.orderStatus).toBe("partially_invoiced");

      const row = await db.salesInvoice.findUniqueOrThrow({
        where: { documentNo: inv.documentNo },
        include: { lines: true },
      });
      expect(row.status).toBe("issued");
      expect(Number(row.netAmount)).toBe(15_000);
      expect(Number(row.vatAmount)).toBe(3_000);
      expect(row.lines[0]!.deliveryLineNo).toBe(1);
      expect(Number((await lineOf("SO-1", 1)).invoicedQty)).toBe(60);
    });

    it("FATURA SATIRINDA MALIN CİNSİ YAZAR, KODU DEĞİL", async () => {
      // Vergi Usul Kanunu faturanın "satılan malın cinsini" taşımasını
      // ister; "M-1001" yazan bir satır bunu karşılamaz ve müşteri ne
      // aldığını faturadan okuyamaz.
      await order();
      const deliveryId = await deliver(10);
      const card = await db.item.create({
        data: {
          code: "M-1001",
          name: "Şasi Profili 60x40",
          normalized: "sasi profili 60x40",
          type: "mamul",
          baseUom: "adet",
        },
      });

      const inv = await repo.issueInvoice({
        sources: [{ deliveryId, deliveryLineNo: 1 }],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });

      const row = await db.salesInvoice.findUniqueOrThrow({
        where: { documentNo: inv.documentNo },
        include: { lines: true },
      });
      expect(row.lines[0]!.description).toBe(card.name);
      expect(row.lines[0]!.itemId).toBe("M-1001");
    });

    it("ÜRÜN KARTI YOKSA KOD KALIR — uydurma ad yazılmaz", async () => {
      // İçe aktarılmış eski siparişlerde ürün kartı olmayabilir; kod,
      // hiç yoktan da uydurma bir addan da iyidir.
      await db.salesOrder.create({
        data: {
          orderNo: "SO-KARTSIZ",
          partnerId: customerId,
          committedDate: new Date("2026-06-30"),
          lines: {
            create: [
              { lineNo: 1, itemId: "KARTSIZ-9", uom: "adet", quantity: 5, unitPrice: 100, vatRate: 20 },
            ],
          },
        },
      });
      const r = await repo.postDelivery({
        orderNo: "SO-KARTSIZ",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 5 }],
      });
      const d = await db.delivery.findUniqueOrThrow({ where: { documentNo: r.documentNo } });

      const inv = await repo.issueInvoice({
        sources: [{ deliveryId: d.id, deliveryLineNo: 1 }],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });
      const row = await db.salesInvoice.findUniqueOrThrow({
        where: { documentNo: inv.documentNo },
        include: { lines: true },
      });
      expect(row.lines[0]!.description).toBe("KARTSIZ-9");
    });

    it("AYNI İRSALİYE SATIRI İKİ KEZ FATURALANAMAZ", async () => {
      await order();
      const deliveryId = await deliver(60);
      await repo.issueInvoice({
        sources: [{ deliveryId, deliveryLineNo: 1 }],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });
      await expect(
        repo.issueInvoice({
          sources: [{ deliveryId, deliveryLineNo: 1 }],
          issuedAt: new Date("2026-06-26"),
          userId: USER,
        }),
      ).rejects.toThrow(/ikinci kez faturalanamaz/);
      expect(await db.salesInvoice.count()).toBe(1);
      expect(Number((await lineOf("SO-1", 1)).invoicedQty)).toBe(60);
    });

    it("SEVK EDİLMEMİŞ MAL FATURALANAMAZ — irsaliyesiz kaynak yok", async () => {
      await order();
      await expect(
        repo.issueInvoice({
          sources: [],
          issuedAt: new Date("2026-06-25"),
          userId: USER,
        }),
      ).rejects.toThrow(/en az bir sevkiyat/);
    });

    it("FİYATSIZ KALEM FATURALANAMAZ — uydurma fiyat konmaz", async () => {
      await order("SO-1", { price1: 0 });
      const deliveryId = await deliver(10);
      await expect(
        repo.issueInvoice({
          sources: [{ deliveryId, deliveryLineNo: 1 }],
          issuedAt: new Date("2026-06-25"),
          userId: USER,
        }),
      ).rejects.toThrow(/fiyatsız fatura kesilemez/);
      expect(await db.salesInvoice.count()).toBe(0);
    });

    it("İPTAL EDİLMİŞ İRSALİYE FATURAYA DAYANAK OLAMAZ", async () => {
      await order();
      const deliveryId = await deliver(30);
      const d = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      await repo.cancelDelivery(d.documentNo, USER, "hata");
      await expect(
        repo.issueInvoice({
          sources: [{ deliveryId, deliveryLineNo: 1 }],
          issuedAt: new Date("2026-06-25"),
          userId: USER,
        }),
      ).rejects.toThrow(/dayanak olamaz/);
    });

    it("tam sevk + tam fatura siparişi tamamlar", async () => {
      await order();
      const d1 = await deliver(100, 1);
      const d2 = await deliver(40, 2);
      const inv = await repo.issueInvoice({
        sources: [
          { deliveryId: d1, deliveryLineNo: 1 },
          { deliveryId: d2, deliveryLineNo: 1 },
        ],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });
      // (100×250 + 40×1000) = 65.000 net, %20 = 13.000 → 78.000
      expect(inv.totalAmount).toBe(78_000);
      expect(inv.orderStatus).toBe("completed");
    });

    it("FATURALANMIŞ SEVKİYAT İPTAL EDİLEMEZ", async () => {
      await order();
      const deliveryId = await deliver(60);
      await repo.issueInvoice({
        sources: [{ deliveryId, deliveryLineNo: 1 }],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });
      const d = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
      await expect(repo.cancelDelivery(d.documentNo, USER, "hata")).rejects.toThrow(
        /iade faturası/,
      );
    });

    it("KESİLMİŞ FATURA DEĞİŞTİRİLEMEZ — doğrudan SQL ile bile", async () => {
      await order();
      const deliveryId = await deliver(60);
      const inv = await repo.issueInvoice({
        sources: [{ deliveryId, deliveryLineNo: 1 }],
        issuedAt: new Date("2026-06-25"),
        userId: USER,
      });
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "sales_invoices" SET "total_amount" = 1 WHERE "document_no" = '${inv.documentNo}'`,
        ),
      ).rejects.toThrow(/değiştirilemez/);
      await expect(
        db.$executeRawUnsafe(
          `DELETE FROM "sales_invoices" WHERE "document_no" = '${inv.documentNo}'`,
        ),
      ).rejects.toThrow(/silinemez/);
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "sales_invoice_lines" SET "quantity" = 1 WHERE "invoice_id" = '${
            (await db.salesInvoice.findUniqueOrThrow({ where: { documentNo: inv.documentNo } })).id
          }'`,
        ),
      ).rejects.toThrow(/değiştirilemez/);
    });

    it("FARKLI MÜŞTERİLERİN SEVKİYATI TEK FATURADA BİRLEŞMEZ", async () => {
      await order("SO-1");
      const other = await db.partner.create({
        data: {
          code: "M-0002",
          legalName: "Scania AB",
          normalized: normalizeName("Scania AB").core,
          isCustomer: true,
        },
      });
      await db.salesOrder.create({
        data: {
          orderNo: "SO-2",
          partnerId: other.id,
          committedDate: new Date("2026-06-30"),
          lines: {
            create: [
              { lineNo: 1, itemId: "M-1001", uom: "adet", quantity: 10, unitPrice: 250, vatRate: 20 },
            ],
          },
        },
      });

      const d1 = await deliver(10, 1);
      const r2 = await repo.postDelivery({
        orderNo: "SO-2",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });
      const d2 = await db.delivery.findUniqueOrThrow({ where: { documentNo: r2.documentNo } });

      await expect(
        repo.issueInvoice({
          sources: [
            { deliveryId: d1, deliveryLineNo: 1 },
            { deliveryId: d2.id, deliveryLineNo: 1 },
          ],
          issuedAt: new Date("2026-06-25"),
          userId: USER,
        }),
      ).rejects.toThrow(/Farklı müşterilere/);
    });
  });

  describe("tool katmanı — yetki ve görevler ayrılığı", () => {
    const TENANT: TenantContext = {
      tenantId: "t1",
      schema: SCHEMA,
      locale: "tr-TR",
      baseCurrency: "TRY",
    };
    // Kullanıcı kimliği UUID'dir: stok hareketi `user_id` sütunu UUID
    // tipindedir ve kimin sevk ettiği kaydın ayrılmaz parçasıdır.
    const depo = createPrincipal({ userId: USER, tenantId: "t1", roles: ["depo_sorumlusu"] });
    const cfo = createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000bb",
      tenantId: "t1",
      roles: ["cfo"],
    });
    const operator = createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000cc",
      tenantId: "t1",
      roles: ["operator"],
    });

    function call(tool: string, input: unknown, principal = depo) {
      return invokeConfirmed(tool, input, {
        registry: buildRegistry(new InMemoryDataSource("t1"), { sales: repo }),
        audit: new InMemoryAuditSink(),
        principal,
        tenant: TENANT,
        correlationId: "c1",
        channel: "chat",
        now: () => new Date("2026-06-20T08:00:00.000Z"),
      });
    }

    const catalog = (p: ReturnType<typeof createPrincipal>) =>
      buildRegistry(new InMemoryDataSource("t1"), { sales: repo })
        .visibleTo(p)
        .map((t) => t.name);

    it("DEPO SEVK EDER AMA FATURA KESEMEZ — görevler ayrılığı", () => {
      const c = catalog(depo);
      expect(c).toContain("post_delivery");
      // İPTAL DEPODA DEĞİL: hatayı yapan onu tek başına geri alamaz.
      expect(c).not.toContain("cancel_delivery");
      // Malı gönderen kişi borcu da yazabilseydi, yanlış miktar hiçbir
      // yerde çakışmaz ve fark hiç görünmezdi.
      expect(c).not.toContain("issue_sales_invoice");
    });

    it("CFO FATURA KESER AMA SEVK EDEMEZ", () => {
      const c = catalog(cfo);
      expect(c).toContain("issue_sales_invoice");
      expect(c).toContain("get_sales_order");
      expect(c).toContain("cancel_delivery");
      expect(c).not.toContain("post_delivery");
    });

    it("operatör satış zincirinin hiçbir tool'unu göremez", () => {
      const c = catalog(operator);
      expect(c.filter((n) => n.includes("delivery") || n.includes("invoice") || n.includes("sales"))).toEqual([]);
    });

    it("KATALOGDA GÖRMESE DE INVOKER REDDEDER", async () => {
      await order();
      const res = await call(
        "issue_sales_invoice",
        { sources: [{ deliveryId: "x", deliveryLineNo: 1 }], issuedAt: "2026-06-25", dueDate: null, exchangeRate: null },
        depo,
      );
      expect(res.outcome.ok).toBe(false);
    });

    it("sevkiyat tool'u uçtan uca çalışır ve stok düşer", async () => {
      await order();
      const res = await call("post_delivery", {
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: "2026-06-20T08:00:00.000Z",
        carrierName: "Aras Kargo",
        plateNo: "16 ABC 123",
        lines: [{ orderLineNo: 1, quantity: 25, batchId: null }],
      });
      expect(res.outcome.ok).toBe(true);
      expect(await db.stockMovement.count()).toBe(1);
      expect(Number((await lineOf("SO-1", 1)).deliveredQty)).toBe(25);
    });

    it("SİPARİŞ TOOL'U EKSİK FİYATI RİSK OLARAK SÖYLER", async () => {
      await order("SO-1", { price1: 0 });
      const res = await call("get_sales_order", { orderNo: "SO-1" });
      expect(res.outcome.ok).toBe(true);
      const risks = (res.outcome as unknown as { risks: { message: string }[] }).risks;
      expect(risks.some((r) => r.message.includes("İÇERMİYOR"))).toBe(true);
    });

    it("FATURA TOOL'U EN ÜST YETKİ SEVİYESİNDEDİR", () => {
      const reg = buildRegistry(new InMemoryDataSource("t1"), { sales: repo });
      expect(reg.get("issue_sales_invoice")?.authority).toBe(3);
      // İleri yönlü sevkiyat, `post_stock_movement` ile aynı seviyede;
      // geri alma bir seviye yukarıda.
      expect(reg.get("post_delivery")?.authority).toBe(1);
      expect(reg.get("cancel_delivery")?.authority).toBe(2);
      expect(reg.get("get_sales_order")?.authority).toBe(0);
    });
  });

  describe("sipariş görünümü", () => {
    it("tutarlar kalemlerden hesaplanır", async () => {
      await order();
      const view = await repo.orderByNo("SO-1");
      expect(view!.netAmount).toBe(65_000);
      expect(view!.vatAmount).toBe(13_000);
      expect(view!.totalAmount).toBe(78_000);
      expect(view!.partnerName).toBe("Volvo Group Sweden AB");
    });

    it("FİYATI GİRİLMEMİŞ KALEM TUTARA UYDURULMAZ", async () => {
      await order("SO-1", { price1: 0 });
      const view = await repo.orderByNo("SO-1");
      // Yalnızca 2. kalem fiyatlı: 40 × 1000 = 40.000
      expect(view!.netAmount).toBe(40_000);
      expect(view!.lines[0]!.unitPrice).toBe(0);
    });
  });
});