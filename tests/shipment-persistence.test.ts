/**
 * Sevkiyat riski — gerçek Postgres'e karşı.
 *
 * Bu dosyanın omurgası tek bir iddiadır: **bilmediğini bilmek.**
 * Bir siparişin tarihi hesaplanamıyorsa, sistem onu "risksiz" saymaz.
 * ERP'lerin en pahalı sessiz hatası budur — kimse bakmaz, sipariş gecikir,
 * ceza kesilir ve rapor "her şey yolunda" demiştir.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaShipmentSource, penaltyFor, slipDays } from "../src/db/shipment-source.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_ship";

describe("gecikme ve ceza hesabı", () => {
  it("gün farkı tam gün olarak hesaplanır", () => {
    expect(slipDays(new Date("2026-05-12"), new Date("2026-05-16"))).toBe(4);
    expect(slipDays(new Date("2026-05-16"), new Date("2026-05-12"))).toBe(-4);
    expect(slipDays(new Date("2026-05-16"), new Date("2026-05-16"))).toBe(0);
  });

  it("CEZA TAVANI UYGULANIR", () => {
    // Tavan olmadan 40 günlük gecikme sözleşmenin izin verdiğinin kat kat
    // üstünde bir "risk" üretir ve tüm rapor güvenilmez olur.
    expect(penaltyFor(40, 10_000, null)).toBe(400_000);
    expect(penaltyFor(40, 10_000, 150_000)).toBe(150_000);
  });

  it("SÖZLEŞMEDE CEZA YAZMIYORSA TUTAR UYDURULMAZ", () => {
    expect(penaltyFor(10, null, null)).toBe(0);
  });

  it("gecikme yoksa ceza yok", () => {
    expect(penaltyFor(0, 10_000, null)).toBe(0);
    expect(penaltyFor(-3, 10_000, null)).toBe(0);
  });
});

describe.skipIf(!enabled)("Sevkiyat riski kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let source: PrismaShipmentSource;
  let customerId: string;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    source = new PrismaShipmentSource(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.workOrderOperation.deleteMany();
    await db.workOrder.deleteMany();
    await db.partner.deleteMany();

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

  async function workOrder(id: string, plannedEnd: string | null) {
    return db.workOrder.create({
      data: {
        id,
        itemId: "FR-22",
        quantity: 10,
        status: "released",
        ...(plannedEnd ? { plannedEndDate: new Date(plannedEnd) } : {}),
      },
    });
  }

  async function order(
    orderNo: string,
    committed: string,
    lines: { workOrderId: string | null }[],
    penalty: { perDay?: number | null; cap?: number | null } = {},
  ) {
    return db.salesOrder.create({
      data: {
        orderNo,
        partnerId: customerId,
        committedDate: new Date(committed),
        penaltyPerDay: penalty.perDay ?? null,
        penaltyCap: penalty.cap ?? null,
        lines: {
          create: lines.map((l, i) => ({
            lineNo: (i + 1) * 10,
            itemId: "FR-22",
            quantity: 10,
            workOrderId: l.workOrderId,
          })),
        },
      },
    });
  }

  it("geciken sipariş risk listesine girer", async () => {
    await workOrder("WO-1", "2026-05-16");
    await order("SO-2026-0418", "2026-05-12", [{ workOrderId: "WO-1" }], { perDay: 19_500 });

    const { risks, unknown } = await source.analyze();
    expect(unknown).toEqual([]);
    expect(risks).toEqual([
      {
        salesOrder: "SO-2026-0418",
        customer: "Volvo Group Sweden AB",
        committedDate: "2026-05-12",
        estimatedDate: "2026-05-16",
        slipDays: 4,
        penaltyRiskTry: 78_000,
      },
    ]);
  });

  it("zamanında sipariş risk listesine GİRMEZ", async () => {
    await workOrder("WO-1", "2026-05-10");
    await order("SO-OK", "2026-05-12", [{ workOrderId: "WO-1" }], { perDay: 19_500 });
    const { risks, unknown } = await source.analyze();
    expect(risks).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("İŞ EMRİ BAĞLANMAMIŞ SİPARİŞ 'RİSKSİZ' SAYILMAZ", async () => {
    await order("SO-BAGSIZ", "2026-05-12", [{ workOrderId: null }]);
    const { risks, unknown } = await source.analyze();
    expect(risks).toEqual([]);
    expect(unknown).toEqual([
      {
        salesOrder: "SO-BAGSIZ",
        customer: "Volvo Group Sweden AB",
        committedDate: "2026-05-12",
        reason: "iş emri bağlanmamış",
      },
    ]);
  });

  it("PLANLANAN BİTİŞİ OLMAYAN İŞ EMRİ İÇİN TARİH UYDURULMAZ", async () => {
    await workOrder("WO-PLANSIZ", null);
    await order("SO-PLANSIZ", "2026-05-12", [{ workOrderId: "WO-PLANSIZ" }]);
    const { risks, unknown } = await source.analyze();
    expect(risks).toEqual([]);
    expect(unknown[0]).toMatchObject({ reason: "planlanan bitiş girilmemiş" });
  });

  it("kalemi olmayan sipariş de bilinmeyen sayılır", async () => {
    await order("SO-BOS", "2026-05-12", []);
    const { unknown } = await source.analyze();
    expect(unknown[0]!.salesOrder).toBe("SO-BOS");
  });

  it("BİLİNMEYENLER CEVABA TAŞINIR — port sınırında düşmez", async () => {
    await order("SO-BAGSIZ", "2026-05-12", [{ workOrderId: null }]);
    const { caveats } = await source.shipmentRisks();
    expect(caveats).toHaveLength(1);
    expect(caveats![0]).toContain("SO-BAGSIZ");
    expect(caveats![0]).toContain("BİLİNMİYOR");
  });

  it("SİPARİŞİN TARİHİ EN GEÇ BİTEN KALEMİNİNKİDİR", async () => {
    // Sipariş bir bütün sevk edilir; bir kalem geç kalırsa sipariş geç kalır.
    await workOrder("WO-ERKEN", "2026-05-10");
    await workOrder("WO-GEC", "2026-05-20");
    await order("SO-COKKALEM", "2026-05-12", [
      { workOrderId: "WO-ERKEN" },
      { workOrderId: "WO-GEC" },
    ], { perDay: 1_000 });

    const { risks } = await source.analyze();
    expect(risks[0]).toMatchObject({ estimatedDate: "2026-05-20", slipDays: 8, penaltyRiskTry: 8_000 });
  });

  it("ceza tavanı veritabanından da uygulanır", async () => {
    await workOrder("WO-1", "2026-06-20");
    await order("SO-UZUN", "2026-05-12", [{ workOrderId: "WO-1" }], {
      perDay: 19_500,
      cap: 200_000,
    });
    const { risks } = await source.analyze();
    expect(risks[0]!.slipDays).toBe(39);
    expect(risks[0]!.penaltyRiskTry).toBe(200_000);
  });

  it("cezası tanımsız sipariş gecikme olarak YİNE raporlanır", async () => {
    // Tutar bilinmiyor diye gecikmeyi gizlemek, gecikmeyi yok saymaktır.
    await workOrder("WO-1", "2026-05-20");
    await order("SO-CEZASIZ", "2026-05-12", [{ workOrderId: "WO-1" }]);
    const { risks } = await source.analyze();
    expect(risks[0]).toMatchObject({ slipDays: 8, penaltyRiskTry: 0 });
  });

  it("kapanmış sipariş bakılmaz", async () => {
    await workOrder("WO-1", "2026-05-20");
    const o = await order("SO-KAPALI", "2026-05-12", [{ workOrderId: "WO-1" }]);
    await db.salesOrder.update({ where: { id: o.id }, data: { status: "shipped" } });
    const { risks, unknown } = await source.analyze();
    expect(risks).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("en büyük gecikme başta gelir", async () => {
    await workOrder("WO-A", "2026-05-15");
    await workOrder("WO-B", "2026-05-25");
    await order("SO-AZ", "2026-05-12", [{ workOrderId: "WO-A" }]);
    await order("SO-COK", "2026-05-12", [{ workOrderId: "WO-B" }]);
    const { risks } = await source.analyze();
    expect(risks.map((r) => r.salesOrder)).toEqual(["SO-COK", "SO-AZ"]);
  });
});

/**
 * Uyarıların cevaba taşınması.
 *
 * Kaynak "bilmiyorum" dediğinde tool'un cevabı bunu göstermeli ve güven
 * puanı düşmelidir. İkisi de olmazsa, eksik tablo tam tablo gibi okunur.
 */
describe("kaynak uyarıları", () => {
  it("uyarı yoksa risk üretmez, güven düşmez", async () => {
    const { caveatRisks, confidenceWithCaveats } = await import("../src/data/caveats.js");
    expect(caveatRisks(undefined)).toEqual([]);
    expect(caveatRisks([])).toEqual([]);
    expect(confidenceWithCaveats(88, [])).toBe(88);
  });

  it("uyarı varsa GÜVEN DÜŞER — puan süs değildir", async () => {
    const { confidenceWithCaveats } = await import("../src/data/caveats.js");
    expect(confidenceWithCaveats(88, ["bir şey eksik"])).toBe(68);
    expect(confidenceWithCaveats(88, ["a", "b"])).toBe(48);
  });

  it("güven 40'ın altına inmez — sıfır güven anlamsızdır", async () => {
    const { confidenceWithCaveats } = await import("../src/data/caveats.js");
    expect(confidenceWithCaveats(88, ["a", "b", "c", "d", "e"])).toBe(40);
  });

  it("uyarı cevaba uyarı seviyesinde girer", async () => {
    const { caveatRisks } = await import("../src/data/caveats.js");
    expect(caveatRisks(["3 sipariş bilinmiyor"])).toEqual([
      { severity: "warning", message: "3 sipariş bilinmiyor" },
    ]);
  });
});
