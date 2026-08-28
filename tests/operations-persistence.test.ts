/**
 * Operations kalıcılık ve EŞZAMANLILIK testleri — gerçek Postgres'e karşı.
 *
 * Bellek adaptörünün mutex'i "mantık doğru" der; bu dosya "veritabanı da
 * koruyor" der. İkisi farklı iddialardır ve ERP'lerin sessizce kaybettiği
 * yer ikincisidir: kural uygulamada vardır ama iki eşzamanlı işlem arasından
 * sızar, stok negatife düşer ve kimse ay sonuna kadar fark etmez.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaOperationsRepository } from "../src/db/operations-repository.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import {
  createWorkOrder,
  type RoutingOperation,
} from "../src/modules/operations/work-order.js";
import { releaseWorkOrder, startOperation, confirmOperation, recordGateDecision } from "../src/modules/operations/work-order.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);

const SCHEMA = "tenant_it_ops";
const T = SCHEMA;
const USER = "22222222-2222-2222-2222-222222222222";
const AT = "2026-05-16T08:00:00.000Z";

const uretim = createPrincipal({ userId: USER, tenantId: T, roles: ["uretim_muduru"] });

const ROUTING: readonly RoutingOperation[] = [
  { seq: 10, workCenter: "KESIM", description: "Kesim", gate: null },
  {
    seq: 20,
    workCenter: "KAYNAK",
    description: "Kaynak",
    gate: { characteristic: "Kaynak penetrasyonu", decidedBy: "quality:gate.release" },
  },
  { seq: 30, workCenter: "BOYA", description: "Boya", gate: null },
];

describe.skipIf(!enabled)("Operations kalıcılığı ve eşzamanlılık", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: PrismaOperationsRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new PrismaOperationsRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.stockMovement.deleteMany();
    await db.workOrderOperation.deleteMany();
    await db.workOrder.deleteMany();
    await db.bomRevision.deleteMany();
  });

  // ─────────────────── kalıcılık ───────────────────

  it("iş emri tur atıp aynı hâliyle geri gelir", async () => {
    await repo.saveWorkOrder(
      T,
      createWorkOrder({ id: "WO-P1", itemId: "FR-22", quantity: 10, routing: ROUTING }),
    );
    const loaded = await repo.getWorkOrder(T, "WO-P1");
    expect(loaded?.operations).toHaveLength(3);
    expect(loaded?.operations[1]?.gate?.characteristic).toBe("Kaynak penetrasyonu");
    expect(loaded?.status).toBe("created");
  });

  it("kalite kapısı durumu veritabanında korunur", async () => {
    await db.bomRevision.create({ data: { itemId: "FR-22", revision: "R3", isActive: true } });
    await repo.saveWorkOrder(
      T,
      createWorkOrder({ id: "WO-P2", itemId: "FR-22", quantity: 10, routing: ROUTING }),
    );

    await repo.mutateWorkOrder(T, "WO-P2", (wo) =>
      releaseWorkOrder(wo, { activeBomRevision: "R3", at: AT, principal: uretim }),
    );
    await repo.mutateWorkOrder(T, "WO-P2", (wo) => startOperation(wo, 10));
    await repo.mutateWorkOrder(T, "WO-P2", (wo) => confirmOperation(wo, 10, { confirmedQty: 10 }));
    await repo.mutateWorkOrder(T, "WO-P2", (wo) => startOperation(wo, 20));
    await repo.mutateWorkOrder(T, "WO-P2", (wo) => confirmOperation(wo, 20, { confirmedQty: 10 }));

    const held = await repo.getWorkOrder(T, "WO-P2");
    expect(held?.bomRevision).toBe("R3");
    expect(held?.operations.find((o) => o.seq === 20)?.state).toBe("gate_hold");

    // Kapı beklerken sonraki operasyon — veritabanından yüklenen hâlde de kapalı.
    await expect(
      repo.mutateWorkOrder(T, "WO-P2", (wo) => startOperation(wo, 30)),
    ).rejects.toThrow(/kalite kapısında bekliyor/);

    await repo.mutateWorkOrder(T, "WO-P2", (wo) =>
      recordGateDecision(wo, 20, { decision: "pass", principal: uretim, at: AT }),
    );
    const passed = await repo.getWorkOrder(T, "WO-P2");
    expect(passed?.operations.find((o) => o.seq === 20)?.gateDecision?.decision).toBe("pass");
    await expect(
      repo.mutateWorkOrder(T, "WO-P2", (wo) => startOperation(wo, 30)),
    ).resolves.toBeTruthy();
  });

  // ─────────────────── stok ───────────────────

  async function receive(qty: number, item = "DINGIL") {
    return repo.postMovement(
      T,
      {
        id: "",
        at: AT,
        itemId: item,
        locationId: "DEPO-01",
        batchId: null,
        quantity: qty,
        movementType: "101",
        reference: { kind: "purchase_order", id: "PO-1" },
        userId: USER,
      },
      { authority: 2 },
    );
  }

  function issue(qty: number, item = "DINGIL") {
    return repo.postMovement(
      T,
      {
        id: "",
        at: AT,
        itemId: item,
        locationId: "DEPO-01",
        batchId: null,
        quantity: qty,
        movementType: "261",
        reference: { kind: "work_order", id: "WO-1" },
        userId: USER,
      },
      { authority: 2 },
    );
  }

  it("bakiye SQL'de toplanır ve doğru döner", async () => {
    await receive(200);
    await issue(80);
    expect(await repo.balance(T, { itemId: "DINGIL", locationId: "DEPO-01", batchId: null })).toBe(120);
  });

  it("negatif stok veritabanı katmanında da reddedilir", async () => {
    await receive(50);
    await expect(issue(80)).rejects.toThrow(/negatife düşürür/);
    expect(await repo.balance(T, { itemId: "DINGIL", locationId: "DEPO-01", batchId: null })).toBe(50);
  });

  it("iptal ters hareket olarak yazılır, asıl kayıt kalır", async () => {
    const gr = await receive(100);
    await repo.postMovement(
      T,
      {
        id: "",
        at: AT,
        itemId: "DINGIL",
        locationId: "DEPO-01",
        batchId: null,
        quantity: 100,
        movementType: "102",
        reference: { kind: "purchase_order", id: "PO-1" },
        userId: USER,
        reason: "Yanlış kalem okundu",
        reversalOf: gr.id,
      },
      { authority: 2 },
    );
    expect(await db.stockMovement.count()).toBe(2);
    expect(await repo.balance(T, { itemId: "DINGIL", locationId: "DEPO-01", batchId: null })).toBe(0);
  });

  it("aynı hareket iki kez iptal edilemez — veritabanında da", async () => {
    const gr = await receive(100);
    const reversal = {
      id: "",
      at: AT,
      itemId: "DINGIL",
      locationId: "DEPO-01",
      batchId: null,
      quantity: 100,
      movementType: "102",
      reference: { kind: "purchase_order" as const, id: "PO-1" },
      userId: USER,
      reason: "ilk iptal",
      reversalOf: gr.id,
    };
    await repo.postMovement(T, reversal, { authority: 2 });
    await expect(
      repo.postMovement(T, { ...reversal, reason: "ikinci iptal" }, { authority: 2 }),
    ).rejects.toThrow(/zaten iptal edilmiş/);
  });

  // ─────────────────── EŞZAMANLILIK ───────────────────

  it("eşzamanlı çağrılarda bakiye asla negatife düşmez", async () => {
    await receive(10);
    const results = await Promise.allSettled([issue(8), issue(8)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const balance = await repo.balance(T, { itemId: "DINGIL", locationId: "DEPO-01", batchId: null });
    expect(balance).toBe(2);
  });

  it("yüksek çekişme altında toplam korunur: 100'den 20×10 denemesi, tam 10'u geçer", async () => {
    await receive(100);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => issue(10)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(await repo.balance(T, { itemId: "DINGIL", locationId: "DEPO-01", batchId: null })).toBe(0);
  }, 30_000);

  /**
   * Yukarıdaki iki test değişmezin KORUNDUĞUNU gösterir ama KİLİDİN sebep
   * olduğunu kanıtlamaz — çağrılar pratikte sırayla akabilir ve test kilit
   * kapalıyken de geçer (denendi, geçti). Bu yüzden mekanizmayı ayrıca ve
   * doğrudan kanıtlamak gerekiyor: aşağıdaki iki test, iki AYRI bağlantı
   * üzerinde açık transaction denetimiyle kilidin gerçekten serileştirdiğini
   * ve kilitsiz hâlde yarış penceresinin GERÇEKTEN açık olduğunu gösterir.
   */
  describe("kilit mekanizmasının kendisi", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const LOCK = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;
    const BALANCE = `SELECT COALESCE(SUM(quantity * direction), 0)::float8 AS balance
                       FROM stock_movements
                      WHERE item_id = $1 AND location_id = $2 AND batch_id IS NULL`;

    let a: TenantPrisma;
    let b: TenantPrisma;

    beforeAll(() => {
      // Ayrı client = ayrı bağlantı havuzu = gerçekten eşzamanlı işlemler.
      a = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
      b = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    });

    afterAll(async () => {
      await a?.$disconnect();
      await b?.$disconnect();
    });

    it("KİLİTSİZ: iki işlem AYNI bakiyeyi okur — yarış penceresi gerçek", async () => {
      await receive(10);
      const seen: number[] = [];

      const t1 = a.$transaction(async (tx) => {
        const r = await tx.$queryRawUnsafe<{ balance: number }[]>(BALANCE, "DINGIL", "DEPO-01");
        seen.push(r[0]!.balance);
        await sleep(250); // karar ile yazma arasındaki gerçek pencere
      }, { timeout: 15_000 });

      await sleep(60);

      const t2 = b.$transaction(async (tx) => {
        const r = await tx.$queryRawUnsafe<{ balance: number }[]>(BALANCE, "DINGIL", "DEPO-01");
        seen.push(r[0]!.balance);
      }, { timeout: 15_000 });

      await Promise.all([t1, t2]);
      // İkisi de 10 gördü: kilitsiz hâlde ikisi de "8 çıkabilir" derdi → −6.
      expect(seen).toEqual([10, 10]);
    }, 30_000);

    it("KİLİTLİ: ikinci işlem birincisi bitene kadar BEKLER", async () => {
      const key = "stock:DINGIL|DEPO-01|";
      let secondAcquiredAt: number | null = null;
      const started = Date.now();

      const t1 = a.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(LOCK, key);
        await sleep(300); // kilidi tut
      }, { timeout: 15_000 });

      await sleep(60);

      const t2 = b.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(LOCK, key);
        secondAcquiredAt = Date.now() - started;
      }, { timeout: 15_000 });

      // 200 ms'de ikinci işlem HÂLÂ kilidi alamamış olmalı.
      await sleep(200);
      expect(secondAcquiredAt).toBeNull();

      await Promise.all([t1, t2]);
      expect(secondAcquiredAt).not.toBeNull();
      // Ancak birincinin 300 ms'i dolduktan sonra alabildi.
      expect(secondAcquiredAt!).toBeGreaterThanOrEqual(290);
    }, 30_000);

    it("REPOSITORY kilidi gerçekten alıyor — dışarıdan tutulan kilit onu bekletir", async () => {
      // Zinciri kapatan test: yukarıdakiler mekanizmayı kanıtlar, bu da
      // repository'nin o mekanizmayı KULLANDIĞINI. `postMovement` içinden
      // advisory lock satırı silinirse bu test kırılır.
      await receive(100);
      const key = "stock:DINGIL|DEPO-01|";
      let repoDoneAt: number | null = null;
      const started = Date.now();

      const holder = a.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(LOCK, key);
        await sleep(400);
      }, { timeout: 15_000 });

      await sleep(60);
      const repoCall = issue(10).then(() => {
        repoDoneAt = Date.now() - started;
      });

      await sleep(250);
      // Kilit dışarıda tutulurken repository yazamamalı.
      expect(repoDoneAt).toBeNull();

      await Promise.all([holder, repoCall]);
      expect(repoDoneAt).not.toBeNull();
      expect(repoDoneAt!).toBeGreaterThanOrEqual(390);
    }, 30_000);

    it("FARKLI anahtarlar birbirini BEKLETMEZ", async () => {
      let bDone: number | null = null;
      const started = Date.now();

      const t1 = a.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(LOCK, "stock:ITEM-A|DEPO-01|");
        await sleep(300);
      }, { timeout: 15_000 });

      await sleep(60);

      const t2 = b.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(LOCK, "stock:ITEM-B|DEPO-01|");
        bDone = Date.now() - started;
      }, { timeout: 15_000 });

      await Promise.all([t1, t2]);
      // Farklı anahtar: beklemeden geçti.
      expect(bDone!).toBeLessThan(250);
    }, 30_000);
  });

  it("EŞZAMANLI İŞ EMRİ GÜNCELLEMESİ: iyimser kilit kaybolan güncellemeyi yakalar", async () => {
    await db.bomRevision.create({ data: { itemId: "FR-22", revision: "R3", isActive: true } });
    await repo.saveWorkOrder(
      T,
      createWorkOrder({ id: "WO-C1", itemId: "FR-22", quantity: 10, routing: ROUTING }),
    );
    await repo.mutateWorkOrder(T, "WO-C1", (wo) =>
      releaseWorkOrder(wo, { activeBomRevision: "R3", at: AT, principal: uretim }),
    );

    // İki operatör aynı operasyonu aynı anda başlatmaya çalışıyor.
    const results = await Promise.allSettled([
      repo.mutateWorkOrder(T, "WO-C1", (wo) => startOperation(wo, 10)),
      repo.mutateWorkOrder(T, "WO-C1", (wo) => startOperation(wo, 10)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const wo = await repo.getWorkOrder(T, "WO-C1");
    expect(wo?.operations.find((o) => o.seq === 10)?.state).toBe("running");
  });
});
