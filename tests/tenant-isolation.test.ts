/**
 * Aşama 1 entegrasyon testleri — GERÇEK veritabanına karşı koşar.
 *
 * Buradaki iddialar sahte adaptörle kanıtlanamaz:
 *   - iki tenant'ın verisi birbirini gerçekten göremiyor mu?
 *   - audit tablosu veritabanı seviyesinde gerçekten değişmez mi?
 *
 * SHARED_DATABASE_URL yoksa test paketi atlanır (CI'da veritabanı sağlanır).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import {
  assertSafeSchemaName,
  dropTenantSchema,
  provisionTenantSchema,
  tenantSchemaName,
} from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { PostgresAuditSink } from "../src/db/audit-sink.js";
import { buildEntry } from "../src/kernel/audit.js";
import { createPrincipal } from "../src/kernel/rbac.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);

describe.skipIf(!enabled)("schema-per-tenant izolasyonu", () => {
  let shared: SharedPrisma;
  let orthaus: TenantPrisma;
  let zerey: TenantPrisma;
  const schemaA = "tenant_it_orthaus";
  const schemaB = "tenant_it_zerey";

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, schemaA);
    await dropTenantSchema(shared, schemaB);
    await provisionTenantSchema(shared, schemaA);
    await provisionTenantSchema(shared, schemaB);
    orthaus = new TenantPrisma({
      datasources: { db: { url: urlForSchema(TENANT_URL!, schemaA) } },
    });
    zerey = new TenantPrisma({
      datasources: { db: { url: urlForSchema(TENANT_URL!, schemaB) } },
    });
  }, 60_000);

  afterAll(async () => {
    await orthaus?.$disconnect();
    await zerey?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, schemaA);
      await dropTenantSchema(shared, schemaB);
      await shared.$disconnect();
    }
  });

  it("provisioning idempotenttir", async () => {
    const again = await provisionTenantSchema(shared, schemaA);
    expect(again.created).toBe(false);
    expect(again.schema).toBe(schemaA);
  });

  it("bir tenant'ın partner'ı diğerinde GÖRÜNMEZ", async () => {
    await orthaus.partner.create({
      data: {
        code: "SUP-00432",
        legalName: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.",
        normalized: "burcelik bursa celik dokum sanayi",
        isSupplier: true,
      },
    });

    expect(await orthaus.partner.count()).toBe(1);
    expect(await zerey.partner.count()).toBe(0);

    const fromA = await orthaus.partner.findFirst({ where: { code: "SUP-00432" } });
    const fromB = await zerey.partner.findFirst({ where: { code: "SUP-00432" } });
    expect(fromA?.legalName).toContain("Burçelik");
    expect(fromB).toBeNull();
  });

  it("aynı kod iki tenant'ta bağımsızca kullanılabilir", async () => {
    await zerey.partner.create({
      data: {
        code: "SUP-00432",
        legalName: "Bambaşka Tekstil Ltd. Şti.",
        normalized: "bambaska tekstil",
        isSupplier: true,
      },
    });
    const a = await orthaus.partner.findFirst({ where: { code: "SUP-00432" } });
    const b = await zerey.partner.findFirst({ where: { code: "SUP-00432" } });
    expect(a?.legalName).not.toBe(b?.legalName);
  });

  it("audit kaydı yazılır", async () => {
    const sink = new PostgresAuditSink(orthaus);
    const principal = createPrincipal({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: schemaA,
      roles: ["patron"],
    });
    await sink.append(
      buildEntry({
        id: crypto.randomUUID(),
        principal,
        channel: "chat",
        correlationId: "c-it-1",
        toolName: "get_factory_wip",
        authority: 0,
        outcome: "success",
        input: { secret_token: "gizli", currency: "TRY" },
        durationMs: 12,
        at: new Date(),
      }),
    );
    const rows = await orthaus.auditEntry.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe("get_factory_wip");
    // hassas alan audit'e maskelenerek yazılır
    expect(JSON.stringify(rows[0]?.input)).toContain("[maskelendi]");
    expect(JSON.stringify(rows[0]?.input)).not.toContain("gizli");
  });

  it("audit kaydı veritabanı seviyesinde GÜNCELLENEMEZ", async () => {
    const row = await orthaus.auditEntry.findFirst();
    await expect(
      orthaus.auditEntry.update({
        where: { id: row!.id },
        data: { outcome: "denied" },
      }),
    ).rejects.toThrow(/değiştirilemez veya silinemez/);
  });

  it("audit kaydı veritabanı seviyesinde SİLİNEMEZ", async () => {
    const row = await orthaus.auditEntry.findFirst();
    await expect(
      orthaus.auditEntry.delete({ where: { id: row!.id } }),
    ).rejects.toThrow(/değiştirilemez veya silinemez/);
  });

  it("KVKK silme talebi: şema DROP edilir, kontrol düzlemi etkilenmez", async () => {
    const throwaway = "tenant_it_gecici";
    await provisionTenantSchema(shared, throwaway);
    const before = await shared.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM information_schema.schemata WHERE schema_name = $1`,
      throwaway,
    );
    expect(Number(before[0]!.count)).toBe(1);

    await dropTenantSchema(shared, throwaway);
    const after = await shared.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM information_schema.schemata WHERE schema_name = $1`,
      throwaway,
    );
    expect(Number(after[0]!.count)).toBe(0);
    // kontrol düzlemi ayakta
    expect(await shared.tenant.count()).toBeGreaterThanOrEqual(0);
  });
});

describe("şema adı güvenliği (veritabanı gerekmez)", () => {
  it("SQL enjeksiyonu denemesi reddedilir", () => {
    expect(() => assertSafeSchemaName('tenant_x"; DROP SCHEMA shared; --')).toThrow(
      /Güvensiz şema adı/,
    );
    expect(() => assertSafeSchemaName("public")).toThrow(/Güvensiz şema adı/);
    expect(() => assertSafeSchemaName("shared")).toThrow(/Güvensiz şema adı/);
  });

  it("Türkçe slug güvenli şema adına çevrilir", () => {
    expect(tenantSchemaName("Orthaus Treyler")).toBe("tenant_orthaus_treyler");
    expect(tenantSchemaName("Zerey Tekstil A.Ş.")).toBe("tenant_zerey_tekstil_a_s");
    expect(tenantSchemaName("ÇĞİÖŞÜ")).toBe("tenant_cgiosu");
  });
});


/**
 * Demo veri kaynağının kiracı sınırı.
 *
 * Bu test gerçek bir hatadan doğdu: `InMemoryDataSource` `tenantId`
 * parametresini görmezden geliyor ve hangi şirket sorarsa sorsun aynı
 * satırları döndürüyordu. Gerçek bir oturumla giren kullanıcı, kendi
 * şirketinin ekranında başka bir şirketin rakamlarını görüyordu.
 */
describe("demo veri kaynağı kiracı sınırı", () => {
  it("bağlı olduğu tenant'a veri verir", async () => {
    const db = new InMemoryDataSource("t-benim");
    const banks = await db.bankBalances("t-benim", null);
    const ships = await db.shipmentRisks("t-benim", 0);
    expect(banks.rows.length).toBeGreaterThan(0);
    expect(ships.rows.length).toBeGreaterThan(0);
  });

  it("BAŞKA TENANT'A HİÇBİR SATIR VERMEZ", async () => {
    const db = new InMemoryDataSource("t-benim");
    expect((await db.bankBalances("t-baskasi", null)).rows).toEqual([]);
    expect((await db.shipmentRisks("t-baskasi", 0)).rows).toEqual([]);
    expect((await db.wipSnapshot("t-baskasi")).rows.stations).toEqual([]);
    expect((await db.partnerCandidates("t-baskasi", { name: "Burçelik", taxId: null })).rows).toEqual([]);
    expect(
      (await db.overtime("t-baskasi", { employeeQuery: null, department: null, period: "2026-05" })).rows,
    ).toEqual([]);
  });

  it("bağsız kaynak KİMSEYE veri vermez — hata boş tarafta yapılır", async () => {
    const db = new InMemoryDataSource();
    expect((await db.bankBalances("t-herhangi", null)).rows).toEqual([]);
  });

  it("kayıt sayısı da sızmaz", async () => {
    const db = new InMemoryDataSource("t-benim");
    // Boş satır dönüp "3 kayıt" demek, kaç müşterisi olduğunu ele verirdi.
    expect((await db.shipmentRisks("t-baskasi", 0)).freshness.recordCount).toBe(0);
  });
});
