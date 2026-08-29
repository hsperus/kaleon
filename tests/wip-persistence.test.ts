/**
 * Fabrika anlık durumu — gerçek Postgres'e karşı.
 *
 * Tek bir iddiayı sınar: **bilinmeyen sayı uydurulmaz.**
 * "0 makine çalışıyor" ile "makine kaydı yok" aynı ekranda aynı görünürse,
 * ya fabrika durmuş sanılır ya da gerçek duruş fark edilmez.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaWipSource } from "../src/db/wip-source.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_wip";

describe.skipIf(!enabled)("Fabrika anlık durumu", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let source: PrismaWipSource;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    source = new PrismaWipSource(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.machineStatusSnapshot.deleteMany();
    await db.machine.deleteMany();
    await db.workCenter.deleteMany();
    await db.workOrderOperation.deleteMany();
    await db.workOrder.deleteMany();
  });

  async function center(code: string, capacity: number | null, target: number | null = null) {
    return db.workCenter.create({
      data: {
        code,
        name: code,
        concurrentCapacity: capacity,
        targetRatePerHour: target,
      },
    });
  }

  async function workOrderWith(id: string, ops: { seq: number; wc: string; state: string }[]) {
    return db.workOrder.create({
      data: {
        id,
        itemId: "FR-22",
        quantity: 10,
        status: "released",
        operations: {
          create: ops.map((o) => ({
            seq: o.seq,
            workCenter: o.wc,
            description: o.wc,
            state: o.state,
          })),
        },
      },
    });
  }

  it("aktif iş emri sayılır", async () => {
    await workOrderWith("WO-1", [{ seq: 10, wc: "KESIM", state: "in_progress" }]);
    await workOrderWith("WO-2", [{ seq: 10, wc: "KESIM", state: "ready" }]);
    const { rows } = await source.wipSnapshot();
    expect(rows.activeWorkOrders).toBe(2);
  });

  it("kapanmış iş emri sayılmaz", async () => {
    const wo = await workOrderWith("WO-1", [{ seq: 10, wc: "KESIM", state: "in_progress" }]);
    await db.workOrder.update({ where: { id: wo.id }, data: { status: "closed" } });
    const { rows } = await source.wipSnapshot();
    expect(rows.activeWorkOrders).toBe(0);
  });

  it("istasyon yükü operasyon durumlarından türer", async () => {
    await center("KESIM", 4);
    await workOrderWith("WO-1", [
      { seq: 10, wc: "KESIM", state: "in_progress" },
      { seq: 20, wc: "KAYNAK", state: "blocked" },
    ]);
    const { rows } = await source.wipSnapshot();
    const kesim = rows.stations.find((s) => s.station === "KESIM")!;
    const kaynak = rows.stations.find((s) => s.station === "KAYNAK")!;
    expect(kesim).toMatchObject({ activeOrders: 1, holdOrders: 0, utilizationPct: 25 });
    expect(kaynak).toMatchObject({ activeOrders: 0, holdOrders: 1 });
  });

  it("KAPASİTESİ TANIMSIZ İSTASYON '%0 DOLU' DEĞİL, 'BİLİNMİYOR'", async () => {
    // %0 doluluk boş bir tezgâh demektir ve yanlış karar verdirir.
    await workOrderWith("WO-1", [{ seq: 10, wc: "KAYNAK", state: "in_progress" }]);
    const { rows, caveats } = await source.wipSnapshot();
    expect(rows.stations[0]).toMatchObject({ station: "KAYNAK", utilizationPct: null });
    expect(caveats!.some((c) => c.includes("kapasitesi tanımlı değil"))).toBe(true);
  });

  it("yükü olmayan iş merkezi de görünür — boş tezgâh da bilgidir", async () => {
    await center("BOYA", 2);
    const { rows } = await source.wipSnapshot();
    expect(rows.stations).toEqual([
      expect.objectContaining({ station: "BOYA", activeOrders: 0, utilizationPct: 0 }),
    ]);
  });

  it("MAKİNE KAYDI YOKSA '0 MAKİNE' DENMEZ", async () => {
    const { rows, caveats } = await source.wipSnapshot();
    expect(rows.machinesTotal).toBe(null);
    expect(rows.machinesRunning).toBe(null);
    expect(caveats!.some((c) => c.includes("Makine kaydı yok"))).toBe(true);
  });

  it("çalışan makine en güncel durumdan sayılır", async () => {
    const wc = await center("KESIM", 4);
    const a = await db.machine.create({ data: { code: "M-1", name: "Testere", workCenterId: wc.id } });
    const b = await db.machine.create({ data: { code: "M-2", name: "Pres", workCenterId: wc.id } });
    await db.machineStatusSnapshot.createMany({
      data: [
        { machineId: a.id, asOf: new Date("2026-05-16T06:00:00Z"), state: "down" },
        { machineId: a.id, asOf: new Date("2026-05-16T09:00:00Z"), state: "running" },
        { machineId: b.id, asOf: new Date("2026-05-16T09:00:00Z"), state: "down", reason: "Arıza" },
      ],
    });
    const { rows } = await source.wipSnapshot();
    expect(rows).toMatchObject({ machinesTotal: 2, machinesRunning: 1 });
  });

  it("GEÇMİŞ DURUŞ KAYDI SİLİNMEZ — OEE analizi buna dayanır", async () => {
    const a = await db.machine.create({ data: { code: "M-1", name: "Testere" } });
    await db.machineStatusSnapshot.createMany({
      data: [
        { machineId: a.id, asOf: new Date("2026-05-16T06:00:00Z"), state: "down" },
        { machineId: a.id, asOf: new Date("2026-05-16T09:00:00Z"), state: "running" },
      ],
    });
    expect(await db.machineStatusSnapshot.count()).toBe(2);
  });

  it("kayıtlı ama durumu hiç gelmemiş makine için sayı UYDURULMAZ", async () => {
    await db.machine.create({ data: { code: "M-1", name: "Testere" } });
    const { rows, caveats } = await source.wipSnapshot();
    expect(rows.machinesTotal).toBe(1);
    expect(rows.machinesRunning).toBe(null);
    expect(caveats!.some((c) => c.includes("durum bilgisi gelmemiş"))).toBe(true);
  });

  it("bazı makinelerden durum gelmiyorsa bu SÖYLENİR", async () => {
    const a = await db.machine.create({ data: { code: "M-1", name: "Testere" } });
    await db.machine.create({ data: { code: "M-2", name: "Pres" } });
    await db.machineStatusSnapshot.create({
      data: { machineId: a.id, asOf: new Date("2026-05-16T09:00:00Z"), state: "running" },
    });
    const { rows, caveats } = await source.wipSnapshot();
    expect(rows).toMatchObject({ machinesTotal: 2, machinesRunning: 1 });
    expect(caveats!.some((c) => c.includes("durum bilgisi gelmiyor"))).toBe(true);
  });

  it("hedef hız tanımlı iş merkezlerinden toplanır", async () => {
    await center("KESIM", 4, 20);
    await center("KAYNAK", 2, 18);
    await center("BOYA", 2, null);
    const { rows } = await source.wipSnapshot();
    expect(rows.targetRatePerHour).toBe(38);
  });

  it("hiç hedef tanımlı değilse null döner, sıfır değil", async () => {
    await center("KESIM", 4, null);
    const { rows, caveats } = await source.wipSnapshot();
    expect(rows.targetRatePerHour).toBe(null);
    expect(caveats!.some((c) => c.includes("hedef hız tanımlı değil"))).toBe(true);
  });

  it("BAĞLANMAMIŞ KANALLAR NULL VE GEREKÇELİ", async () => {
    const { rows, caveats } = await source.wipSnapshot();
    expect(rows.staffOnShift).toBe(null);
    expect(rows.staffPlanned).toBe(null);
    expect(rows.actualRatePerHour).toBe(null);
    expect(caveats!.some((c) => c.includes("vardiyadaki personel"))).toBe(true);
    expect(caveats!.some((c) => c.includes("gerçek üretim hızı"))).toBe(true);
  });

  it("en yoğun istasyon başta gelir", async () => {
    await center("KESIM", 10);
    await center("KAYNAK", 10);
    await workOrderWith("WO-1", [
      { seq: 10, wc: "KESIM", state: "in_progress" },
      { seq: 20, wc: "KAYNAK", state: "in_progress" },
    ]);
    await workOrderWith("WO-2", [{ seq: 10, wc: "KAYNAK", state: "in_progress" }]);
    const { rows } = await source.wipSnapshot();
    expect(rows.stations[0]!.station).toBe("KAYNAK");
  });
});
