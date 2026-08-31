/**
 * İzlemelerin kalıcılığı ve brifinge bağlanması.
 *
 * İZLEME BİR GÜVENLİK YÜZEYİDİR: arka planda, kullanıcı bakmadan
 * çalışır. Testler üç şeyi koruyor — yazan tool izlenemez, kullanıcı
 * göremediği veriyi izleyemez ve çalışamayan izleme sessiz kalmaz.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { WatchRepository, WatchRepositoryError } from "../src/db/watch-repository.js";
import { buildBriefing } from "../src/modules/briefing/engine.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import { invokeTool } from "../src/kernel/invoke.js";
import { invokeConfirmed } from "./helpers/confirm.js";
import type { TenantContext } from "../src/kernel/types.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_watch";
const USER = "00000000-0000-0000-0000-0000000000aa";
const TENANT: TenantContext = {
  tenantId: "t-watch",
  schema: SCHEMA,
  locale: "tr-TR",
  baseCurrency: "TRY",
};

describe.skipIf(!enabled)("izleme kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: WatchRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new WatchRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "watches"`);
  });

  const def = {
    name: "Kasa alt sınırı",
    tool: "get_bank_balance",
    toolInput: { currency: null },
    path: "total",
    operator: "lt" as const,
    threshold: 50_000,
    level: 2 as const,
    message: "Kasa {deger} TL'ye düştü.",
    ownerUserId: USER,
  };

  it("izleme kurulur ve listelenir", async () => {
    await repo.create(def);
    const rows = await repo.listFor(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Kasa alt sınırı");
    expect(rows[0]!.isActive).toBe(true);
    expect(rows[0]!.fireCount).toBe(0);
  });

  it("AYNI ADLA İKİNCİ İZLEME KURULAMAZ", async () => {
    // Kurulabilseydi aynı uyarı ekranda iki kez çıkardı.
    await repo.create(def);
    await expect(repo.create(def)).rejects.toThrow(WatchRepositoryError);
  });

  it("BAŞKASININ İZLEMESİ GÖRÜNMEZ", async () => {
    await repo.create(def);
    const other = await repo.listFor("00000000-0000-0000-0000-0000000000bb");
    expect(other).toHaveLength(0);
  });

  it("koşu kaydı tutulur — tetiklenmese bile", async () => {
    // "Değişirse" izlemesi ancak son değer her koşuda güncellenirse çalışır.
    const w = await repo.create(def);
    await repo.recordCheck(w.id, 80_000, false);
    const rows = await repo.listFor(USER);
    expect(rows[0]!.lastValue).toBe(80_000);
    expect(rows[0]!.lastCheckedAt).not.toBeNull();
    expect(rows[0]!.fireCount).toBe(0);
    expect(rows[0]!.lastFiredAt).toBeNull();
  });

  it("tetiklenince sayaç artar", async () => {
    const w = await repo.create(def);
    await repo.recordCheck(w.id, 40_000, true);
    await repo.recordCheck(w.id, 30_000, true);
    const rows = await repo.listFor(USER);
    expect(rows[0]!.fireCount).toBe(2);
    expect(rows[0]!.lastFiredAt).not.toBeNull();
  });

  it("susturulan izleme aktif listeden düşer", async () => {
    await repo.create(def);
    await repo.setActive(USER, def.name, false);
    expect(await repo.activeFor(USER)).toHaveLength(0);
    // Ama silinmez: eşiği ve geçmişi durur.
    expect(await repo.listFor(USER)).toHaveLength(1);
  });

  it("kaldırılan izleme geri gelmez", async () => {
    await repo.create(def);
    expect(await repo.remove(USER, def.name)).toBe(true);
    expect(await repo.listFor(USER)).toHaveLength(0);
    expect(await repo.remove(USER, def.name)).toBe(false);
  });
});

describe.skipIf(!enabled)("izleme tool katmanı ve brifing", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: WatchRepository;
  let registry: ReturnType<typeof buildRegistry>;
  let audit: InMemoryAuditSink;

  const patron = createPrincipal({ userId: USER, tenantId: TENANT.tenantId, roles: ["patron"] });
  const depo = createPrincipal({
    userId: "00000000-0000-0000-0000-0000000000cc",
    tenantId: TENANT.tenantId,
    roles: ["depo_sorumlusu"],
  });

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA + "2");
    await provisionTenantSchema(shared, SCHEMA + "2");
    db = new TenantPrisma({
      datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA + "2") } },
    });
    repo = new WatchRepository(db);
    audit = new InMemoryAuditSink();
    registry = buildRegistry(new InMemoryDataSource(TENANT.tenantId), { watches: repo, audit });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA + "2");
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "watches"`);
  });

  const ctx = (principal = patron) => ({
    registry,
    audit,
    principal,
    tenant: { ...TENANT, schema: SCHEMA + "2" } as TenantContext,
    correlationId: "c1",
    channel: "ui" as const,
  });

  it("okuma tool'una izleme kurulur", async () => {
    const r = await invokeConfirmed(
      "create_watch",
      {
        name: "Kasa alt sınırı",
        tool: "get_bank_balance",
        toolInput: { currency: null },
        // Toplam kullanılabilir bakiye — "kasada ne kadar var"
        // sorusunun cevabı. Önce `length` izleniyordu çünkü sonuç bir
        // DİZİYDİ ve hesap SAYISINDAN başka izlenebilir bir şey yoktu.
        path: "totalAvailable",
        operator: "gt",
        threshold: 0,
        level: 2,
        message: "Kasa {deger} TL'ye düştü.",
      },
      ctx(),
    );
    expect(r.outcome.ok).toBe(true);
  });

  it("YAZAN TOOL İZLENEMEZ", async () => {
    /*
     * Yazan bir tool'u izlemeye bağlamak, arka planda kendiliğinden
     * çalışan bir yazma demektir: kullanıcı ekranı açar, işlem yapılır.
     */
    const r = await invokeConfirmed(
      "create_watch",
      {
        name: "Kötü izleme",
        tool: "post_stock_movement",
        toolInput: {},
        path: "x",
        operator: "gt",
        threshold: 1,
        level: 1,
        message: "olmaz",
      },
      ctx(),
    );
    expect(r.outcome.ok).toBe(false);
    if (!r.outcome.ok) expect(r.outcome.message).toMatch(/izlenemez|L\d/);
  });

  it("OLMAYAN TOOL İZLENEMEZ", async () => {
    // Kurulsaydı her koşuda sessizce düşer, uyarı hiç gelmezdi.
    const r = await invokeConfirmed(
      "create_watch",
      {
        name: "Hayali izleme",
        tool: "get_hayali_veri",
        toolInput: {},
        path: "x",
        operator: "gt",
        threshold: 1,
        level: 1,
        message: "olmaz",
      },
      ctx(),
    );
    expect(r.outcome.ok).toBe(false);
  });

  it("GÖREMEDİĞİ VERİYİ İZLEYEMEZ", async () => {
    // Depo sorumlusu banka bakiyesini göremez; izleyemez de.
    const r = await invokeConfirmed(
      "create_watch",
      {
        name: "Depo nakit izlemesi",
        tool: "get_bank_balance",
        toolInput: { currency: null },
        path: "total",
        operator: "lt",
        threshold: 1,
        level: 1,
        message: "olmaz",
      },
      ctx(depo),
    );
    expect(r.outcome.ok).toBe(false);
  });

  it("GİRDİSİ GEÇERSİZ İZLEME KURULAMAZ", async () => {
    /*
     * BU HATA GERÇEKTEN YAŞANDI: boş girdiyle kurulan bir izleme
     * kaydedildi, listede "aktif" göründü ve her koşuda sessizce
     * düştü. Kullanıcı izlediğini sanıyordu; izlenmiyordu.
     */
    const r = await invokeConfirmed(
      "create_watch",
      {
        name: "Eksik girdili",
        tool: "get_bank_balance",
        toolInput: {},
        path: "total",
        operator: "lt",
        threshold: 10,
        level: 1,
        message: "olmaz",
      },
      ctx(),
    );
    expect(r.outcome.ok).toBe(false);
    if (!r.outcome.ok) expect(r.outcome.message).toContain("geçersiz");
  });

  it("TETİKLENEN İZLEME BRİFİNGTE ÇIKAR", async () => {
    await repo.create({
      name: "Nakit eşiği",
      tool: "get_bank_balance",
      toolInput: { currency: null },
      // Toplam bakiye. Tool artık satırların yanında toplamı da
      // döndürüyor; önce yalnızca dizi dönüyordu ve izlenebilecek
      // tek sayı hesap adediydi.
      path: "totalAvailable",
      operator: "gt",
      threshold: 0,
      level: 2,
      message: "Kullanılabilir bakiye {deger} (eşik {esik}).",
      ownerUserId: USER,
    });

    const b = await buildBriefing(
      { registry, audit, watches: repo },
      {
        principal: patron,
        tenant: { ...TENANT, schema: SCHEMA + "2" },
        correlationId: "c2",
        channel: "job",
      },
    );

    const signal = b.signals.find((s) => s.title === "Nakit eşiği");
    expect(signal).toBeTruthy();
    expect(signal!.level).toBe(2);
    // Şablon dolduruldu: "bilinmiyor" yazmıyorsa değer okunmuş demektir.
    expect(signal!.detail).not.toContain("bilinmiyor");
    expect(b.brokenWatches).toHaveLength(0);
  });

  it("ÇALIŞAMAYAN İZLEME SESSİZ KALMAZ", async () => {
    // Yol bulunamazsa kullanıcı uyarı bekler ve hiç gelmez; bu yüzden
    // brifing "bu izleme çalışmadı" der.
    await repo.create({
      name: "Bozuk yol",
      tool: "get_bank_balance",
      toolInput: { currency: null },
      path: "olmayan.alan",
      operator: "lt",
      threshold: 10,
      level: 2,
      message: "olmaz",
      ownerUserId: USER,
    });

    const b = await buildBriefing(
      { registry, audit, watches: repo },
      {
        principal: patron,
        tenant: { ...TENANT, schema: SCHEMA + "2" },
        correlationId: "c3",
        channel: "job",
      },
    );

    expect(b.brokenWatches.map((w) => w.name)).toContain("Bozuk yol");
    expect(b.signals.find((s) => s.title === "Bozuk yol")).toBeUndefined();
  });

  it("izleme koşusu DENETİM KAYDINA düşer", async () => {
    // İzleme ayrıcalıklı bir yol değildir: normal tool yolundan geçer.
    audit.entries.length = 0;
    await repo.create({
      name: "Denetim izi",
      tool: "get_bank_balance",
      toolInput: { currency: null },
      path: "length",
      operator: "gt",
      threshold: 0,
      level: 1,
      message: "var",
      ownerUserId: USER,
    });
    await buildBriefing(
      { registry, audit, watches: repo },
      {
        principal: patron,
        tenant: { ...TENANT, schema: SCHEMA + "2" },
        correlationId: "c4",
        channel: "job",
      },
    );
    expect(audit.entries.some((e) => e.toolName === "get_bank_balance")).toBe(true);
  });

  it("susturulan izleme brifingte çalışmaz", async () => {
    await repo.create({
      name: "Susturulacak",
      tool: "get_bank_balance",
      toolInput: { currency: null },
      path: "length",
      operator: "gt",
      threshold: 0,
      level: 2,
      message: "var",
      ownerUserId: USER,
    });
    await repo.setActive(USER, "Susturulacak", false);

    const b = await buildBriefing(
      { registry, audit, watches: repo },
      {
        principal: patron,
        tenant: { ...TENANT, schema: SCHEMA + "2" },
        correlationId: "c5",
        channel: "job",
      },
    );
    expect(b.signals.find((s) => s.title === "Susturulacak")).toBeUndefined();
  });
});
