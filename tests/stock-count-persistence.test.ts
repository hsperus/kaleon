/**
 * Stok sayımı — gerçek Postgres'e karşı.
 *
 * Sayım, sistemin gerçekle yüzleştiği tek andır. Bu dosya iki şeyi sınar:
 * yüzleşmenin DÜRÜST olduğunu (kör sayım, dondurulmuş miktar) ve sonucun
 * hem depoya hem muhasebeye AYNI ANDA yansıdığını.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { StockCountRepository } from "../src/db/stock-count-repository.js";
import { ValuationRepository } from "../src/db/valuation-repository.js";
import { JournalRepository } from "../src/db/journal-repository.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_count";
const USER = "00000000-0000-0000-0000-0000000000aa";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe.skipIf(!enabled)("stok sayımı kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: StockCountRepository;
  let valuation: ValuationRepository;
  let journal: JournalRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new StockCountRepository(db);
    valuation = new ValuationRepository(db);
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
    for (const t of ["stock_count_lines", "stock_counts", "journal_lines", "journal_entries"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
      await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
      await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
    await db.stockMovement.deleteMany();
    await db.itemCostState.deleteMany();
    await db.itemUnit.deleteMany();
    await db.item.deleteMany();
    await db.documentNumberRange.deleteMany();
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "accounting_periods"`);
    await db.$executeRawUnsafe(`ALTER TABLE "accounting_periods" ENABLE TRIGGER USER`);

    await db.item.create({
      data: {
        code: "HM-100",
        name: "Çelik Levha",
        normalized: "celik levha",
        type: "hammadde",
        baseUom: "kg",
      },
    });
    await valuation.postReceipt({
      itemId: "HM-100",
      locationId: "DEPO-1",
      quantity: 100,
      unitCost: 50,
      at: d("2026-06-01"),
      userId: USER,
    });
  });

  const openCount = (blind = true) =>
    repo.open({
      locationId: "DEPO-1",
      countDate: d("2026-06-15"),
      userId: USER,
      blind,
    });

  describe("açılış", () => {
    it("bakiyeler ve maliyetler DONDURULUR", async () => {
      const c = await openCount();
      expect(c.documentNo).toBe("SAY20260001");
      expect(c.lines).toHaveLength(1);

      // Sayım açıldıktan sonraki hareket, dondurulmuş miktarı değiştirmez.
      await valuation.postReceipt({
        itemId: "HM-100",
        locationId: "DEPO-1",
        quantity: 50,
        unitCost: 50,
        at: d("2026-06-16"),
        userId: USER,
      });
      const line = await db.stockCountLine.findFirstOrThrow();
      expect(Number(line.systemQty)).toBe(100);
      expect(Number(line.unitCost)).toBe(50);
    });

    it("KÖR SAYIMDA SİSTEM MİKTARI GİZLENİR", async () => {
      // Gösterilseydi o sayı kopyalanır ve sayım hiçbir şey bulmazdı.
      const c = await openCount(true);
      expect(c.lines[0]!.systemQty).toBe(null);
    });

    it("kör olmayan sayımda miktar görünür", async () => {
      const c = await openCount(false);
      expect(c.lines[0]!.systemQty).toBe(100);
    });

    it("sayılacak kalem yoksa sayım açılmaz", async () => {
      await db.itemCostState.deleteMany();
      await expect(openCount()).rejects.toThrow(/Sayılacak kalem bulunamadı/);
    });
  });

  describe("sayım girişi", () => {
    it("SAYILMAYAN KALEM SIFIR SAYILMAZ", async () => {
      await db.item.create({
        data: { code: "HM-200", name: "Vida", normalized: "vida", type: "sarf", baseUom: "adet" },
      });
      await valuation.postReceipt({
        itemId: "HM-200",
        locationId: "DEPO-1",
        quantity: 500,
        unitCost: 2,
        at: d("2026-06-01"),
        userId: USER,
      });
      const c = await openCount();
      const r = await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 95 }]);
      expect(r.remaining).toBe(1);

      // Eksik sayım kaydedilemez; sayılmayan kalem tam kayıp yazılmaz.
      await expect(
        repo.post({ documentNo: c.documentNo, userId: USER }),
      ).rejects.toThrow(/henüz sayılmamış/);
    });

    it("tüm kalemler girilince durum 'counted' olur", async () => {
      const c = await openCount();
      const r = await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 95 }]);
      expect(r.remaining).toBe(0);
      const row = await db.stockCount.findUniqueOrThrow({ where: { documentNo: c.documentNo } });
      expect(row.status).toBe("counted");
    });

    it("NEGATİF SAYIM REDDEDİLİR", async () => {
      const c = await openCount();
      await expect(
        repo.record(c.documentNo, [{ lineNo: 1, countedQty: -5 }]),
      ).rejects.toThrow(/negatif olamaz/);
    });

    it("olmayan kaleme miktar girilemez", async () => {
      const c = await openCount();
      await expect(
        repo.record(c.documentNo, [{ lineNo: 99, countedQty: 5 }]),
      ).rejects.toThrow(/99 numaralı kalem yok/);
    });
  });

  describe("farklar", () => {
    it("fark ve değeri hesaplanır", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 97 }]);
      const r = await repo.differences(c.documentNo);
      expect(r.differences[0]).toMatchObject({
        difference: -3,
        valueDifference: -150,
        needsRecount: false,
      });
    });

    it("BÜYÜK FARK TEKRAR SAYIM İSTER", async () => {
      // 100 yerine 10 yazılması, 90 birimlik "kayıp" olarak kalıcı
      // muhasebeleşmemeli.
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 10 }]);
      const r = await repo.differences(c.documentNo);
      expect(r.summary.recountLines).toEqual([1]);
      await expect(
        repo.post({ documentNo: c.documentNo, userId: USER }),
      ).rejects.toThrow(/TEKRAR SAYIM/);
    });

    it("küçük mutlak fark oran büyük olsa da tekrar sayım istemez", async () => {
      // 3 adet stoktan 1 eksik %33'tür ama 2 adetlik bir fark için ikinci
      // sayım istemek, eşiği anlamsız gürültüye çevirir.
      await db.itemCostState.updateMany({ data: { quantityOnHand: 3 } });
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 2 }]);
      const r = await repo.differences(c.documentNo);
      expect(r.summary.recountLines).toEqual([]);
    });

    it("açıkça kabul edilirse büyük fark kaydedilir", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 10 }]);
      await expect(
        repo.post({ documentNo: c.documentNo, userId: USER, acceptLargeDifferences: true }),
      ).resolves.toMatchObject({ adjustedLines: 1 });
    });
  });

  describe("kayıt", () => {
    it("STOK, HAREKET VE MUHASEBE BİRLİKTE DÜZELİR", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 97 }]);
      const r = await repo.post({ documentNo: c.documentNo, userId: USER });

      expect(r.adjustedLines).toBe(1);
      expect(r.netValueDifference).toBe(-150);
      expect(r.journalNo).toBeTruthy();

      // Bakiye sayılan miktara çekildi.
      const state = await db.itemCostState.findUniqueOrThrow({ where: { itemId: "HM-100" } });
      expect(Number(state.quantityOnHand)).toBe(97);

      // Hareket yazıldı.
      const mv = await db.stockMovement.findFirstOrThrow({
        where: { movementType: "sayim_farki" },
      });
      expect(mv.direction).toBe(-1);
      expect(Number(mv.quantity)).toBe(3);

      // EKSİK SAYIM 689'A YAZILIR, maliyete değil: kaybolan mal satılmış
      // gibi görünmemeli.
      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      expect(tb.rows.find((x) => x.accountCode === "689")!.debit).toBe(150);
      expect(tb.rows.find((x) => x.accountCode === "150")!.credit).toBe(150);
      expect(tb.balanced).toBe(true);
    });

    it("fazla sayım stoğu artırır", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 104 }]);
      await repo.post({ documentNo: c.documentNo, userId: USER });

      const tb = await journal.trialBalance(d("2026-06-01"), d("2026-06-30"));
      expect(tb.rows.find((x) => x.accountCode === "150")!.debit).toBe(200);
      expect(tb.rows.find((x) => x.accountCode === "689")!.credit).toBe(200);
    });

    it("FARK YOKSA FİŞ AÇILMAZ", async () => {
      // "Sayım tuttu" durumunda boş fiş açmak defteri anlamsız kayıtlarla
      // doldurur.
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 100 }]);
      const r = await repo.post({ documentNo: c.documentNo, userId: USER });
      expect(r.adjustedLines).toBe(0);
      expect(r.journalNo).toBe(null);
      expect(await db.journalEntry.count()).toBe(0);
    });

    it("AYNI SAYIM İKİ KEZ KAYDEDİLEMEZ", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 97 }]);
      await repo.post({ documentNo: c.documentNo, userId: USER });
      await expect(
        repo.post({ documentNo: c.documentNo, userId: USER }),
      ).rejects.toThrow(/zaten kaydedilmiş/);
    });

    it("KAYDEDİLEN SAYIM DEĞİŞTİRİLEMEZ — doğrudan SQL ile bile", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 97 }]);
      await repo.post({ documentNo: c.documentNo, userId: USER });
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "stock_count_lines" SET "counted_qty" = 100
             WHERE "count_id" = (SELECT "id" FROM "stock_counts" WHERE "document_no"='${c.documentNo}')`,
        ),
      ).rejects.toThrow(/değiştirilemez/);
    });

    it("KAPALI DÖNEME SAYIM KAYDEDİLEMEZ", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 97 }]);
      await db.accountingPeriod.create({
        data: { year: 2026, month: 6, status: "closed", closedAt: new Date() },
      });
      await expect(
        repo.post({ documentNo: c.documentNo, userId: USER }),
      ).rejects.toThrow(/Haziran 2026 dönemi kapalı/);
    });

    it("kaydedilmiş sayım iptal edilemez", async () => {
      const c = await openCount();
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 97 }]);
      await repo.post({ documentNo: c.documentNo, userId: USER });
      await expect(repo.cancel(c.documentNo)).rejects.toThrow(/iptal edilemez/);
    });

    it("MALİYETİ BİLİNMEYEN FARK STOĞU DÜZELTİR AMA FİŞE GİRMEZ", async () => {
      await db.item.create({
        data: { code: "HM-900", name: "Bilinmeyen", normalized: "bilinmeyen", type: "hammadde", baseUom: "adet" },
      });
      await db.itemCostState.create({
        data: { itemId: "HM-900", quantityOnHand: 20, unitCost: null },
      });
      const c = await repo.open({
        locationId: "DEPO-1",
        countDate: d("2026-06-15"),
        userId: USER,
        itemCodes: ["HM-900"],
      });
      await repo.record(c.documentNo, [{ lineNo: 1, countedQty: 18 }]);
      const r = await repo.post({ documentNo: c.documentNo, userId: USER });

      expect(r.adjustedLines).toBe(1);
      expect(r.journalNo).toBe(null);
      const state = await db.itemCostState.findUniqueOrThrow({ where: { itemId: "HM-900" } });
      expect(Number(state.quantityOnHand)).toBe(18);
    });
  });
});
