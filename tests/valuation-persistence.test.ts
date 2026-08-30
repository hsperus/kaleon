/**
 * Değerleme ve döviz kuru — gerçek Postgres'e karşı.
 *
 * Buradaki asıl iddia şu: MALİYET, HAREKETİN KENDİSİYLE BİRLİKTE DONAR.
 * Sonradan hesaplanan maliyet, geçmiş raporları her gün değiştirir; dün
 * "kârlı" görünen sipariş bugün zararlı çıkar ve kimse hangisinin doğru
 * olduğunu söyleyemez.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { ValuationRepository } from "../src/db/valuation-repository.js";
import { SalesRepository } from "../src/db/sales-repository.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { invokeTool } from "../src/kernel/invoke.js";
import { invokeConfirmed } from "./helpers/confirm.js";
import { createPrincipal, REDACTED } from "../src/kernel/rbac.js";
import type { TenantContext } from "../src/kernel/types.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_val";
const USER = "00000000-0000-0000-0000-0000000000aa";

describe.skipIf(!enabled)("değerleme kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: ValuationRepository;
  let sales: SalesRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new ValuationRepository(db);
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
    await db.exchangeRate.deleteMany();
    await db.documentNumberRange.deleteMany();
  });

  const receipt = (qty: number, cost: number, opts: { currency?: string; at?: string } = {}) =>
    repo.postReceipt({
      itemId: "M-1001",
      locationId: "DEPO-1",
      quantity: qty,
      unitCost: cost,
      at: new Date(opts.at ?? "2026-06-15"),
      userId: USER,
      ...(opts.currency ? { currency: opts.currency } : {}),
    });

  describe("döviz kuru", () => {
    it("kaydedilen kur işlem tarihine göre bulunur", async () => {
      await repo.saveRate({ currency: "EUR", rate: 36.4, quotedAt: new Date("2026-06-15") });
      await repo.saveRate({ currency: "EUR", rate: 36.55, quotedAt: new Date("2026-06-16") });
      const r = await repo.rateFor("EUR", new Date("2026-06-15"));
      expect(r.rate).toBe(36.4);
      expect(r.quotedAt).toBe("2026-06-15");
    });

    it("KUR YOKSA HESAP YAPILMAZ", async () => {
      await expect(repo.toTry(1000, "EUR", new Date("2026-06-15"))).rejects.toThrow(
        /Kur bilinmeden/,
      );
    });

    it("aynı güne ikinci ilan kuru GÜNCELLER, ikinci satır açmaz", async () => {
      await repo.saveRate({ currency: "USD", rate: 33.1, quotedAt: new Date("2026-06-15") });
      await repo.saveRate({ currency: "USD", rate: 33.4, quotedAt: new Date("2026-06-15") });
      expect(await db.exchangeRate.count({ where: { currency: "USD" } })).toBe(1);
      expect((await repo.rateFor("USD", new Date("2026-06-15"))).rate).toBe(33.4);
    });

    it("SIFIR KUR VERİTABANI SEVİYESİNDE REDDEDİLİR", async () => {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "exchange_rates" ("id","currency","rate","quoted_at","source","created_at")
           VALUES (gen_random_uuid(), 'EUR', 0, DATE '2026-06-15', 'manuel', NOW())`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("hareketli ortalama", () => {
    it("girişler ağırlıklı ortalamayı oluşturur", async () => {
      await receipt(100, 50);
      const r = await receipt(100, 70);
      expect(r.unitCost).toBe(60);
      expect(r.quantityOnHand).toBe(200);

      const state = await db.itemCostState.findUniqueOrThrow({ where: { itemId: "M-1001" } });
      expect(Number(state.unitCost)).toBe(60);
      expect(Number(state.totalValue)).toBe(12_000);
    });

    it("YABANCI PARA ALIM TL'YE ÇEVRİLEREK ORTALAMAYA GİRER", async () => {
      await repo.saveRate({ currency: "EUR", rate: 36.4, quotedAt: new Date("2026-06-15") });
      const r = await receipt(10, 100, { currency: "EUR" });
      // 100 EUR × 36,4 = 3.640 TL birim maliyet
      expect(r.unitCost).toBe(3_640);
      expect(r.rate).toBe(36.4);

      const mv = await db.stockMovement.findFirstOrThrow();
      expect(mv.sourceCurrency).toBe("EUR");
      expect(Number(mv.exchangeRate)).toBe(36.4);
      expect(Number(mv.unitCost)).toBe(3_640);
    });

    it("KURU OLMAYAN ALIM KAYDEDİLMEZ — 1 varsayılıp TL sanılmaz", async () => {
      await expect(receipt(10, 100, { currency: "EUR" })).rejects.toThrow(/Kur bilinmeden/);
      expect(await db.stockMovement.count()).toBe(0);
      expect(await db.itemCostState.count()).toBe(0);
    });

    it("EŞZAMANLI İKİ GİRİŞ ORTALAMAYI KAYBETMEZ", async () => {
      await receipt(100, 50);
      await Promise.all([receipt(100, 70), receipt(100, 90)]);
      const state = await db.itemCostState.findUniqueOrThrow({ where: { itemId: "M-1001" } });
      // (100×50 + 100×70 + 100×90) / 300 = 70. Kilit olmadan biri kaybolur.
      expect(Number(state.quantityOnHand)).toBe(300);
      expect(Number(state.unitCost)).toBe(70);
    });
  });

  describe("sevkiyat maliyeti", () => {
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

    it("ÇIKIŞ MALİYETİ HAREKETLE BİRLİKTE DONAR", async () => {
      await receipt(100, 50);
      await receipt(100, 70); // ortalama 60
      await orderWithStock();

      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 50 }],
      });

      const out = await db.stockMovement.findFirstOrThrow({ where: { movementType: "sevkiyat" } });
      expect(Number(out.unitCost)).toBe(60);
      expect(Number(out.value)).toBe(3_000);

      // Sonraki pahalı alım GEÇMİŞ çıkışın maliyetini değiştirmez.
      await receipt(100, 200);
      const again = await db.stockMovement.findUniqueOrThrow({ where: { id: out.id } });
      expect(Number(again.unitCost)).toBe(60);
    });

    it("çıkış bakiyeyi düşer, ORTALAMAYI DEĞİŞTİRMEZ", async () => {
      await receipt(100, 50);
      await receipt(100, 70);
      await orderWithStock();
      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 50 }],
      });

      const state = await db.itemCostState.findUniqueOrThrow({ where: { itemId: "M-1001" } });
      expect(Number(state.quantityOnHand)).toBe(150);
      expect(Number(state.unitCost)).toBe(60);
      expect(Number(state.totalValue)).toBe(9_000);
    });

    it("İPTAL ÖZGÜN MALİYETİ TAŞIR VE BAKİYEYİ GERİ VERİR", async () => {
      await receipt(100, 50);
      await orderWithStock();
      const d = await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 40 }],
      });
      await receipt(100, 300); // ortalama yükselir
      await sales.cancelDelivery(d.documentNo, USER, "yanlış müşteri");

      const rev = await db.stockMovement.findFirstOrThrow({
        where: { movementType: "sevkiyat_iptal" },
      });
      // Güncel ortalamayla geri alınsaydı iptal kâr/zarar üretirdi.
      expect(Number(rev.unitCost)).toBe(50);
      expect(Number(rev.value)).toBe(2_000);

      const state = await db.itemCostState.findUniqueOrThrow({ where: { itemId: "M-1001" } });
      expect(Number(state.quantityOnHand)).toBe(200);
    });

    it("MALİYETİ BİLİNMEYEN MAL SIFIR MALİYETLE ÇIKMAZ", async () => {
      await orderWithStock();
      await sales.postDelivery({
        orderNo: "SO-1",
        locationId: "DEPO-1",
        shippedAt: new Date("2026-06-20"),
        userId: USER,
        lines: [{ orderLineNo: 1, quantity: 10 }],
      });
      const out = await db.stockMovement.findFirstOrThrow({ where: { movementType: "sevkiyat" } });
      // Sıfır yazsaydı bu sipariş %100 kârlı görünürdü.
      expect(out.unitCost).toBe(null);
      expect(out.value).toBe(null);
    });
  });

  describe("envanter değeri", () => {
    it("MALİYETİ BİLİNMEYEN KALEM TOPLAMA GİRMEZ, AYRI SAYILIR", async () => {
      await receipt(100, 50);
      await db.itemCostState.create({
        data: { itemId: "M-9999", quantityOnHand: 500, unitCost: null },
      });

      const v = await repo.inventoryValue();
      expect(v.totalValue).toBe(5_000);
      expect(v.valuedItems).toBe(1);
      expect(v.unvaluedItems).toBe(1);
      expect(v.unvaluedCodes).toContain("M-9999");
    });

    it("bakiyesi sıfır olan kalem toplamı şişirmez", async () => {
      await db.itemCostState.create({
        data: { itemId: "M-8888", quantityOnHand: 0, unitCost: 100 },
      });
      const v = await repo.inventoryValue();
      expect(v.valuedItems).toBe(0);
      expect(v.totalValue).toBe(0);
    });
  });

  describe("tool katmanı — maliyet gizliliği", () => {
    const TENANT: TenantContext = {
      tenantId: "t1",
      schema: SCHEMA,
      locale: "tr-TR",
      baseCurrency: "TRY",
    };
    const depo = createPrincipal({ userId: USER, tenantId: "t1", roles: ["depo_sorumlusu"] });
    const cfo = createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000bb",
      tenantId: "t1",
      roles: ["cfo"],
    });

    function call(tool: string, input: unknown, principal = depo) {
      return invokeConfirmed(tool, input, {
        registry: buildRegistry(new InMemoryDataSource("t1"), { valuation: repo }),
        audit: new InMemoryAuditSink(),
        principal,
        tenant: TENANT,
        correlationId: "c1",
        channel: "chat",
        now: () => new Date("2026-06-15T08:00:00.000Z"),
      });
    }

    const receiptInput = {
      itemCode: "M-1001",
      locationId: "DEPO-1",
      quantity: 100,
      unitCost: 50,
      currency: "TRY",
      receivedAt: "2026-06-15T08:00:00.000Z",
      batchId: null,
    };

    it("DEPO MAL KABUL EDER AMA ORTALAMA MALİYETİ GÖREMEZ", async () => {
      const res = await call("post_goods_receipt", receiptInput);
      expect(res.outcome.ok).toBe(true);
      const data = (res.outcome as unknown as { data: Record<string, unknown> }).data;
      // Girdiği birim fiyatı zaten biliyor; TÜM alımların ortalaması ise
      // mali bir bilgidir ve ona kapalıdır.
      expect(data["newUnitCost"]).toBe(REDACTED);
      expect(data["quantityOnHand"]).toBe(100);
      // Kayıt gerçekten yazıldı — maskeleme işlemi engellemez.
      expect(Number((await db.itemCostState.findUniqueOrThrow({ where: { itemId: "M-1001" } })).unitCost)).toBe(50);
    });

    it("RİSK MESAJI DA MALİYET SIZDIRMAZ", async () => {
      const res = await call("post_goods_receipt", receiptInput);
      const risks = (res.outcome as unknown as { risks: { message: string }[] }).risks;
      expect(risks[0]!.message).not.toContain("50,00");
      expect(risks[0]!.message).toContain("giriş kaydedildi");
    });

    it("HEM GİRİŞ HEM DEĞERLEME YETKİSİ OLAN ROL MALİYETİ GÖRÜR", async () => {
      // Üretim müdürü ikisine de sahiptir: fire ve rota kararı maliyet bilir.
      const uretim = createPrincipal({
        userId: "00000000-0000-0000-0000-0000000000dd",
        tenantId: "t1",
        roles: ["uretim_muduru"],
      });
      const res = await call("post_goods_receipt", receiptInput, uretim);
      const data = (res.outcome as unknown as { data: Record<string, unknown> }).data;
      expect(data["newUnitCost"]).toBe(50);
    });

    it("CFO MAL KABUL EDEMEZ — malı alan ile maliyeti onaylayan ayrıdır", async () => {
      const res = await call("post_goods_receipt", receiptInput, cfo);
      expect(res.outcome.ok).toBe(false);
    });

    it("CFO maliyeti okuma tool'uyla görür", async () => {
      await receipt(100, 50);
      const res = await call("get_item_cost", { itemCode: "M-1001" }, cfo);
      const data = (res.outcome as unknown as { data: Record<string, unknown> }).data;
      expect(data["unitCost"]).toBe(50);
      expect(data["totalValue"]).toBe(5_000);
    });

    it("depo maliyet tool'larını KATALOGDA GÖREMEZ", () => {
      const names = buildRegistry(new InMemoryDataSource("t1"), { valuation: repo })
        .visibleTo(depo)
        .map((t) => t.name);
      expect(names).toContain("post_goods_receipt");
      expect(names).not.toContain("get_item_cost");
      expect(names).not.toContain("get_inventory_value");
      expect(names).not.toContain("set_exchange_rate");
    });

    it("KUR YAZMA YALNIZCA CFO'DA", () => {
      const names = buildRegistry(new InMemoryDataSource("t1"), { valuation: repo })
        .visibleTo(cfo)
        .map((t) => t.name);
      expect(names).toContain("set_exchange_rate");
      expect(names).toContain("get_inventory_value");
    });
  });
});