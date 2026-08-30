/**
 * Satın alma talebi ve ödeme — gerçek Postgres'e karşı.
 *
 * İki kontrol sınanıyor ve ikisi de şirketin klasik suistimallerine karşı:
 *   KENDİ TALEBİNİ ONAYLAMA — isteyen ile onaylayan aynı kişi olamaz.
 *   BAĞLANMAYAN ÖDEME       — para çıkar ama hangi faturaya ait bilinmez.
 *
 * Her ikisi de hem uygulamada hem veritabanında korunuyor; uygulamadaki
 * kullanıcıya anlamlı mesaj verir, veritabanındaki ileride yazılacak bir
 * kod yolunun kuralı atlamasını engeller.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { ProcurementRepository } from "../src/db/procurement-repository.js";
import { PeriodRepository } from "../src/db/period-repository.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_proc";

const ALI = "00000000-0000-0000-0000-00000000a11c";
const AYSE = "00000000-0000-0000-0000-00000000a75e";

describe.skipIf(!enabled)("satın alma talebi ve ödeme kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: ProcurementRepository;
  let periods: PeriodRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new ProcurementRepository(db);
    periods = new PeriodRepository(db);
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
    await db.paymentAllocation.deleteMany();
    await db.payment.deleteMany();
    await db.purchaseRequisitionLine.deleteMany();
    await db.purchaseRequisition.deleteMany();
    await db.purchaseOrderLine.deleteMany();
    await db.purchaseOrder.deleteMany();
    await db.invoiceLine.deleteMany();
    await db.invoiceFinding.deleteMany();
    await db.invoice.deleteMany();
    await db.documentNumberRange.deleteMany();
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "accounting_periods"`);
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" ENABLE TRIGGER USER`);
  });

  const requisition = (price: number | null, qty = 10, by = ALI) =>
    repo.createRequisition({
      requestedBy: by,
      justification: "Hat duruşunu önlemek için yedek rulman",
      at: new Date("2026-06-15"),
      lines: [
        {
          itemCode: "HM-100",
          quantity: qty,
          uom: "adet",
          estimatedPrice: price,
          neededBy: new Date("2026-07-01"),
        },
      ],
    });

  async function invoice(documentNo: string, total: number, matchStatus = "matched") {
    await db.invoice.create({
      data: {
        id: documentNo,
        partnerId: "P-1",
        documentNo,
        issuedAt: new Date("2026-06-10"),
        currency: "TRY",
        matchStatus,
        lines: {
          create: [
            { lineNo: 1, itemId: "HM-100", quantity: 1, unitPrice: total, currency: "TRY" },
          ],
        },
      },
    });
  }

  describe("talep ve onay", () => {
    it("talep numarası alır ve gönderilmiş durumda açılır", async () => {
      const r = await requisition(1_000);
      expect(r.documentNo).toBe("TLP202600001");
      expect(r.status).toBe("submitted");
      expect(r.estimatedTotal).toBe(10_000);
      expect(r.requiredApprover).toBe("satin_alma");
    });

    it("ONAY SEVİYESİ TUTARA GÖRE YÜKSELİR", async () => {
      expect((await requisition(10_000)).requiredApprover).toBe("cfo"); // 100.000
      expect((await requisition(100_000)).requiredApprover).toBe("patron"); // 1.000.000
    });

    it("KENDİ TALEBİNİ ONAYLAYAMAZ", async () => {
      const r = await requisition(1_000);
      await expect(
        repo.approveRequisition({
          documentNo: r.documentNo,
          approverId: ALI,
          approverRoles: ["patron"],
        }),
      ).rejects.toThrow(/Kendi talebinizi onaylayamazsınız/);
    });

    it("KENDİ TALEBİNİ ONAYLAMA VERİTABANINDA DA ENGELLİ", async () => {
      const r = await requisition(1_000);
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "purchase_requisitions" SET "status"='approved', "approved_by"='${ALI}',
             "updated_at"=NOW() WHERE "document_no"='${r.documentNo}'`,
        ),
      ).rejects.toThrow();
    });

    it("YETKİ SEVİYESİ YETMEZSE ONAYLANMAZ", async () => {
      const r = await requisition(100_000); // 1.000.000 TL → patron
      await expect(
        repo.approveRequisition({
          documentNo: r.documentNo,
          approverId: AYSE,
          approverRoles: ["cfo"],
        }),
      ).rejects.toThrow(/Patron.*onayı gerekir/);
    });

    it("FİYATSIZ KALEM ONAY EŞİĞİNİ DÜŞÜREMEZ", async () => {
      // Fiyatsız kalem toplamı düşürüp satın almacının kendi onayına
      // sokabilirdi; onay bu yüzden hiç verilmez.
      const r = await repo.createRequisition({
        requestedBy: ALI,
        at: new Date("2026-06-15"),
        lines: [
          {
            itemCode: "HM-100",
            quantity: 10,
            uom: "adet",
            estimatedPrice: 1_000,
            neededBy: new Date("2026-07-01"),
          },
          {
            itemCode: "HM-200",
            quantity: 5,
            uom: "adet",
            estimatedPrice: null,
            neededBy: new Date("2026-07-01"),
          },
        ],
      });
      expect(r.unpricedLines).toEqual([2]);
      await expect(
        repo.approveRequisition({
          documentNo: r.documentNo,
          approverId: AYSE,
          approverRoles: ["patron"],
        }),
      ).rejects.toThrow(/onay eşiği hesaplanamaz/);
    });

    it("onaylı talep siparişe dönüşür ve ikinci kez dönüşmez", async () => {
      const r = await requisition(1_000);
      await repo.approveRequisition({
        documentNo: r.documentNo,
        approverId: AYSE,
        approverRoles: ["satin_alma"],
      });
      const po = await repo.convertToOrder({
        documentNo: r.documentNo,
        partnerId: "P-1",
        orderedAt: new Date("2026-06-16"),
      });
      expect(po.purchaseOrderId).toBe("SAT202600001");
      expect(po.lines).toBe(1);

      await expect(
        repo.convertToOrder({
          documentNo: r.documentNo,
          partnerId: "P-1",
          orderedAt: new Date("2026-06-16"),
        }),
      ).rejects.toThrow(/zaten siparişe dönüştürülmüş/);
    });

    it("ONAYLANMAMIŞ TALEP SİPARİŞE DÖNÜŞEMEZ", async () => {
      const r = await requisition(1_000);
      await expect(
        repo.convertToOrder({
          documentNo: r.documentNo,
          partnerId: "P-1",
          orderedAt: new Date("2026-06-16"),
        }),
      ).rejects.toThrow(/yalnızca ONAYLI talep/);
      expect(await db.purchaseOrder.count()).toBe(0);
    });

    it("reddedilen talep sebebiyle kaydedilir ve tekrar onaylanamaz", async () => {
      const r = await requisition(1_000);
      await repo.rejectRequisition({
        documentNo: r.documentNo,
        approverId: AYSE,
        reason: "Depoda 40 adet mevcut",
      });
      const row = await db.purchaseRequisition.findUniqueOrThrow({
        where: { documentNo: r.documentNo },
      });
      expect(row.rejectionReason).toBe("Depoda 40 adet mevcut");
      await expect(
        repo.approveRequisition({
          documentNo: r.documentNo,
          approverId: AYSE,
          approverRoles: ["patron"],
        }),
      ).rejects.toThrow(/rejected durumunda/);
    });

    it("sebepsiz ret kabul edilmez", async () => {
      const r = await requisition(1_000);
      await expect(
        repo.rejectRequisition({ documentNo: r.documentNo, approverId: AYSE, reason: "yok" }),
      ).rejects.toThrow(/sebebi yazılmalıdır/);
    });
  });

  describe("ödeme", () => {
    const pay = (amount: number, allocations: { invoiceNo: string; amount: number }[]) =>
      repo.postPayment({
        direction: "outgoing",
        partnerId: "P-1",
        amount,
        method: "havale",
        paidAt: new Date("2026-06-20"),
        userId: AYSE,
        allocations,
      });

    it("ödeme faturaya bağlanır ve fatura kapanır", async () => {
      await invoice("FTR-001", 10_000);
      const res = await pay(10_000, [{ invoiceNo: "FTR-001", amount: 10_000 }]);
      expect(res.documentNo).toBe("ODM2026000001");
      expect(res.closedInvoices).toEqual(["FTR-001"]);

      const bal = await repo.invoiceBalance("FTR-001");
      expect(bal!.paidAmount).toBe(10_000);
    });

    it("DAĞITILMAYAN TUTAR KALAMAZ", async () => {
      await invoice("FTR-001", 10_000);
      await expect(pay(10_000, [{ invoiceNo: "FTR-001", amount: 6_000 }])).rejects.toThrow(
        /Dağıtılmayan tutar/,
      );
      expect(await db.payment.count()).toBe(0);
    });

    it("FAZLA ÖDEME ENGELLENİR", async () => {
      await invoice("FTR-001", 10_000);
      await expect(pay(12_000, [{ invoiceNo: "FTR-001", amount: 12_000 }])).rejects.toThrow(
        /kalan 10.000,00/,
      );
    });

    it("KISMİ ÖDEME SONRASI KALAN DOĞRU HESAPLANIR", async () => {
      await invoice("FTR-001", 10_000);
      await pay(4_000, [{ invoiceNo: "FTR-001", amount: 4_000 }]);
      const bal = await repo.invoiceBalance("FTR-001");
      expect(bal!.paidAmount).toBe(4_000);
      await expect(pay(7_000, [{ invoiceNo: "FTR-001", amount: 7_000 }])).rejects.toThrow(
        /kalan 6.000,00/,
      );
      await expect(pay(6_000, [{ invoiceNo: "FTR-001", amount: 6_000 }])).resolves.toBeTruthy();
    });

    it("BLOKE FATURA ÖDENEMEZ — mutabakat farkı yok sayılamaz", async () => {
      await invoice("FTR-BLK", 10_000, "blocked");
      await expect(pay(10_000, [{ invoiceNo: "FTR-BLK", amount: 10_000 }])).rejects.toThrow(
        /MUTABAKAT FARKI/,
      );
    });

    it("OLMAYAN FATURAYA ÖDEME BAĞLANAMAZ", async () => {
      await expect(pay(1_000, [{ invoiceNo: "YOK-1", amount: 1_000 }])).rejects.toThrow(
        /sistemde yok/,
      );
    });

    it("KAPALI DÖNEME ÖDEME GİRİLEMEZ", async () => {
      await invoice("FTR-001", 10_000);
      await periods.close({ year: 2026, month: 6, userId: AYSE, force: true });
      await expect(pay(10_000, [{ invoiceNo: "FTR-001", amount: 10_000 }])).rejects.toThrow(
        /Haziran 2026 dönemi kapalı/,
      );
      expect(await db.payment.count()).toBe(0);
    });

    it("tek ödeme birden çok faturaya dağıtılır", async () => {
      await invoice("FTR-001", 6_000);
      await invoice("FTR-002", 4_000);
      const res = await pay(10_000, [
        { invoiceNo: "FTR-001", amount: 6_000 },
        { invoiceNo: "FTR-002", amount: 4_000 },
      ]);
      expect([...res.closedInvoices].sort()).toEqual(["FTR-001", "FTR-002"]);
    });

    it("AÇIK FATURA LİSTESİ BLOKE OLANLARI GÖSTERMEZ", async () => {
      await invoice("FTR-001", 10_000);
      await invoice("FTR-BLK", 50_000, "blocked");
      const rows = await repo.openPayables(new Date("2026-06-20"));
      expect(rows.map((r) => r.documentNo)).toEqual(["FTR-001"]);
    });

    it("tamamen ödenmiş fatura açık listede görünmez", async () => {
      await invoice("FTR-001", 10_000);
      await pay(10_000, [{ invoiceNo: "FTR-001", amount: 10_000 }]);
      expect(await repo.openPayables(new Date("2026-06-20"))).toEqual([]);
    });
  });
});
