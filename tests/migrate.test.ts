/**
 * Tenant migration runner.
 *
 * Bu dosyanın varlık sebebi somut bir arıza: yeni tablolar eklendiğinde
 * ZATEN KURULMUŞ tenant'lar onları hiç göremiyordu. `provisionTenantSchema`
 * tam DDL'i yalnızca boş şemaya uygular; tekrar çalıştırılamaz çünkü
 * `CREATE TYPE` idempotent değildir. Müşteri eski şemayla kalırdı.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import {
  appliedMigrations,
  loadMigrations,
  migrateTenant,
  pendingMigrations,
  type Migration,
} from "../src/db/migrate.js";
import { dropTenantSchema, splitSqlStatements } from "../src/db/provision.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const enabled = Boolean(SHARED_URL);

function migration(version: number, name: string, sql: string): Migration {
  return {
    version,
    name,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
  };
}

describe("SQL ifade ayırıcı", () => {
  it("noktalı virgülle ayırır", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("YORUM İÇİNDEKİ NOKTALI VİRGÜL İFADE SONU DEĞİLDİR", () => {
    // Gerçek arıza: açıklama satırındaki ";" ifadeyi ikiye böldü ve ikinci
    // yarısı ("şema değişikliği için...") SQL sanılıp çalıştırıldı.
    const sql = `-- şemayı değiştirmeyin; yeni migration yazın
CREATE TABLE t (id int);`;
    expect(splitSqlStatements(sql)).toEqual([
      "-- şemayı değiştirmeyin; yeni migration yazın\nCREATE TABLE t (id int)",
    ]);
  });

  it("blok yorumdaki noktalı virgül de bölmez", () => {
    const sql = "/* a; b */ SELECT 1;";
    expect(splitSqlStatements(sql)).toEqual(["/* a; b */ SELECT 1"]);
  });

  it("tırnak içindeki noktalı virgül bölmez", () => {
    expect(splitSqlStatements("SELECT 'a;b';")).toEqual(["SELECT 'a;b'"]);
  });

  it("dolar tırnaklı gövde bölünmez", () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN a; b; END $$ LANGUAGE plpgsql;";
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });
});

describe("migration dosyaları", () => {
  it("diskteki migration'lar sırayla ve tekilce yüklenir", () => {
    const all = loadMigrations();
    expect(all.length).toBeGreaterThan(0);
    const versions = all.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("her migration'ın checksum'ı var", () => {
    for (const m of loadMigrations()) expect(m.checksum).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe.skipIf(!enabled)("Migration runner", () => {
  let shared: SharedPrisma;
  const SCHEMA = "tenant_it_mig";

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
  }, 30_000);

  afterAll(async () => {
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  const M1 = migration(1, "ilk", "CREATE TABLE deneme (id int primary key);");
  const M2 = migration(2, "ikinci", "ALTER TABLE deneme ADD COLUMN ad text;");

  it("bekleyen migration'ları sırayla uygular", async () => {
    await dropTenantSchema(shared, SCHEMA);
    const r = await migrateTenant(shared, SCHEMA, { migrations: [M1, M2] });
    expect(r.applied).toEqual([1, 2]);
    const done = await appliedMigrations(shared, SCHEMA);
    expect(done.map((d) => d.version)).toEqual([1, 2]);
  }, 30_000);

  it("ikinci koşuda hiçbir şey uygulanmaz — idempotent", async () => {
    const r = await migrateTenant(shared, SCHEMA, { migrations: [M1, M2] });
    expect(r).toMatchObject({ applied: [], alreadyCurrent: true });
  });

  it("YALNIZCA YENİ MIGRATION UYGULANIR — asıl çözülen problem bu", async () => {
    const M3 = migration(3, "ucuncu", "ALTER TABLE deneme ADD COLUMN nott text;");
    const r = await migrateTenant(shared, SCHEMA, { migrations: [M1, M2, M3] });
    expect(r.applied).toEqual([3]);
    const cols = await shared.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'deneme' ORDER BY column_name`,
      SCHEMA,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["ad", "id", "nott"]);
  }, 30_000);

  it("UYGULANMIŞ MIGRATION SONRADAN DEĞİŞTİRİLİRSE HATA VERİR", async () => {
    // Sessizce atlansaydı, geliştirici makinesindeki şema ile müşterideki
    // şema farklılaşır ve fark aylar sonra açıklanamayan bir hata olurdu.
    const tampered = migration(1, "ilk", "CREATE TABLE deneme (id int primary key); -- değişti");
    await expect(migrateTenant(shared, SCHEMA, { migrations: [tampered, M2] })).rejects.toThrow(
      /uygulandıktan SONRA değiştirilmiş/,
    );
  });

  it("uygulanmış migration'ın dosyası silinmişse hata verir", async () => {
    await expect(migrateTenant(shared, SCHEMA, { migrations: [M2] })).rejects.toThrow(
      /dosyası yok/,
    );
  });

  it("YARIM UYGULANMIŞ MIGRATION KALMAZ — her biri kendi transaction'ında", async () => {
    const bad = migration(
      9,
      "bozuk",
      "CREATE TABLE saglam (id int); CREATE TABLE bozuk (BU SQL DEGIL);",
    );
    await expect(
      migrateTenant(shared, SCHEMA, { migrations: [M1, M2, bad] }),
    ).rejects.toThrow();

    // İlk ifade başarılı olsa bile geri alınmalı: yarım şema bırakılmaz.
    const tables = await shared.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'saglam'`,
      SCHEMA,
    );
    expect(Number(tables[0]!.count)).toBe(0);

    // Defterde de iz kalmamalı.
    const done = await appliedMigrations(shared, SCHEMA);
    expect(done.map((d) => d.version)).not.toContain(9);
  }, 30_000);

  it("bekleyenler uygulamadan sorulabilir", async () => {
    const M4 = migration(4, "dorduncu", "SELECT 1;");
    const pending = await pendingMigrations(shared, SCHEMA, [M1, M2, M4]);
    expect(pending.map((m) => m.version)).toEqual([4]);
  });

  it("BASELINE: var olan şema uygulanmış sayılır ama SQL koşmaz", async () => {
    const OTHER = "tenant_it_mig2";
    await dropTenantSchema(shared, OTHER);
    try {
      const r = await migrateTenant(shared, OTHER, { migrations: [M1, M2], baselineTo: 2 });
      expect(r.applied).toEqual([]);
      expect((await appliedMigrations(shared, OTHER)).map((d) => d.version)).toEqual([1, 2]);
      // Tablo OLUŞMAMALI — baseline "zaten vardı" demektir, "kur" demek değil.
      const t = await shared.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'deneme'`,
        OTHER,
      );
      expect(Number(t[0]!.count)).toBe(0);
    } finally {
      await dropTenantSchema(shared, OTHER);
    }
  }, 30_000);
});
