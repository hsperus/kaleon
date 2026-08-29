/**
 * Tenant şema migration runner.
 *
 * PROBLEM: `provisionTenantSchema` tam DDL'i YALNIZCA boş bir şemaya
 * uygular. Zaten kurulmuş bir tenant'a yeni tablo eklemek için tekrar
 * çalıştırılamaz — `CREATE TYPE` idempotent değildir ve patlar. Bu yüzden
 * var olan müşteriler yeni özellikleri hiç göremezdi.
 *
 * ÇÖZÜM: Her tenant şemasında kendi `schema_migrations` tablosu.
 * Migration'lar numaralı SQL dosyalarıdır; her tenant için yalnızca
 * uygulanmamış olanlar sırayla koşar.
 *
 * DÖRT KURAL:
 *
 *  1. HER MIGRATION KENDİ TRANSACTION'INDA. Yarım uygulanmış bir migration,
 *     hangi tablonun oluştuğunu kimsenin bilmediği bir şema bırakır.
 *     Postgres DDL'i transactional; bundan faydalanmamak için sebep yok.
 *
 *  2. CHECKSUM DOĞRULANIR. Uygulanmış bir migration dosyası sonradan
 *     değiştirilirse HATA verilir, sessizce atlanmaz. Aksi hâlde geliştirici
 *     makinesinde çalışan şema ile müşteride olan şema farklılaşır ve bu
 *     fark aylar sonra, açıklanamayan bir hata olarak ortaya çıkar.
 *
 *  3. SIRA GARANTİLİDİR. Migration'lar numara sırasına göre uygulanır;
 *     bir tanesi patlarsa sonrakiler denenmez.
 *
 *  4. KURULUM DA BİR MIGRATION'DIR. Yeni tenant, migration 001'den başlayıp
 *     hepsini uygular. Böylece "yeni kurulan tenant" ile "güncellenmiş
 *     tenant" aynı şemaya sahip olur — iki ayrı kod yolu yoktur.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient as SharedClient } from "./generated/shared/index.js";
import { assertSafeSchemaName, splitSqlStatements } from "./provision.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "../../prisma/tenant-migrations");

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const FILE_RE = /^(\d{3,})_([a-z0-9_-]+)\.sql$/;

export function loadMigrations(dir = MIGRATIONS_DIR): readonly Migration[] {
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const seen = new Set<number>();

  return files.map((file) => {
    const m = FILE_RE.exec(file)!;
    const version = Number(m[1]);
    if (seen.has(version)) {
      throw new Error(`Yinelenen migration numarası: ${version} (${file})`);
    }
    seen.add(version);
    const sql = readFileSync(join(dir, file), "utf8");
    return {
      version,
      name: m[2]!,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrateResult {
  readonly schema: string;
  readonly applied: readonly number[];
  readonly alreadyCurrent: boolean;
}

/** Migration defterini oluşturur (yoksa). */
async function ensureLedger(shared: SharedClient, schema: string): Promise<void> {
  await shared.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await shared.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."schema_migrations" (
       version     integer PRIMARY KEY,
       name        text NOT NULL,
       checksum    text NOT NULL,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/**
 * Uygulanmış migration'lar.
 *
 * BU OKUMA HİÇBİR ŞEY YAZMAZ. Defteri "yoksa oluştur" diye açmak cazip
 * görünür ama tehlikelidir: durum sorgusu, defteri olmayan eski bir şemaya
 * boş bir defter yazar ve o şema bir anda "sıfırdan kurulacak" gibi görünür.
 * Gerçek bir arıza olarak yaşandı — `tenant list` komutu, üç tenant'ın
 * güvenlik kontrolünü sessizce devre dışı bıraktı.
 */
export async function appliedMigrations(
  shared: SharedClient,
  schema: string,
): Promise<readonly AppliedMigration[]> {
  assertSafeSchemaName(schema);
  if (!(await hasLedger(shared, schema))) return [];
  return shared.$queryRawUnsafe<AppliedMigration[]>(
    `SELECT version, name, checksum, applied_at AS "appliedAt"
       FROM "${schema}"."schema_migrations" ORDER BY version`,
  );
}

/**
 * Bekleyen migration'ları uygular.
 *
 * `baselineTo`: zaten var olan ama defteri olmayan bir şemayı, belirtilen
 * numaraya kadar "uygulanmış" sayar. Migration sistemine SONRADAN geçilen
 * şemalar için gerekli — yoksa runner sıfırdan kurmayı dener ve patlar.
 */
export async function migrateTenant(
  shared: SharedClient,
  schema: string,
  opts: { migrations?: readonly Migration[]; baselineTo?: number } = {},
): Promise<MigrateResult> {
  assertSafeSchemaName(schema);
  const migrations = opts.migrations ?? loadMigrations();

  // MIGRATION SİSTEMİNDEN ÖNCE KURULMUŞ ŞEMA.
  // Tabloları var ama defteri yok; hangi sürümde olduğu BİLİNEMEZ. Sıfırdan
  // kurmayı denemek `CREATE TYPE ... already exists` gibi anlaşılmaz bir
  // Postgres hatası verir; "güncel" saymak ise eksik tabloyla çalışan bir
  // müşteri demektir. İkisi de kabul edilemez, o yüzden açıkça reddedilir.
  if (opts.baselineTo === undefined && !(await hasLedger(shared, schema))) {
    if (await hasTables(shared, schema)) {
      throw new Error(
        `${schema}: migration defteri yok ama tablolar var — bu şema migration ` +
          `sisteminden önce kurulmuş ve hangi sürümde olduğu bilinemiyor. ` +
          `Verisi yoksa şemayı silip yeniden kurun; varsa doğru sürümle ` +
          `baseline'layın (migrateTenant(..., { baselineTo: N })).`,
      );
    }
  }

  const already = await appliedMigrations(shared, schema);

  // ── Checksum doğrulaması: uygulanmış bir dosya değiştirilmiş mi?
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const done of already) {
    const file = byVersion.get(done.version);
    if (!file) {
      throw new Error(
        `${schema}: ${done.version} numaralı migration uygulanmış ama dosyası yok. ` +
          `Dosya silinmiş veya yeniden numaralandırılmış olabilir.`,
      );
    }
    if (file.checksum !== done.checksum) {
      throw new Error(
        `${schema}: ${done.version}_${done.name} migration'ı uygulandıktan SONRA değiştirilmiş ` +
          `(defter: ${done.checksum}, dosya: ${file.checksum}). ` +
          `Uygulanmış migration düzenlenmez; yeni bir migration yazın.`,
      );
    }
  }

  if (opts.baselineTo !== undefined && already.length === 0) {
    await ensureLedger(shared, schema);
    for (const m of migrations.filter((x) => x.version <= opts.baselineTo!)) {
      await shared.$executeRawUnsafe(
        `INSERT INTO "${schema}"."schema_migrations" (version, name, checksum)
         VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
        m.version,
        m.name,
        m.checksum,
      );
    }
    return { schema, applied: [], alreadyCurrent: true };
  }

  const doneVersions = new Set(already.map((a) => a.version));
  const pending = migrations
    .filter((m) => !doneVersions.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) return { schema, applied: [], alreadyCurrent: true };

  await ensureLedger(shared, schema);

  const applied: number[] = [];
  for (const m of pending) {
    // HER MIGRATION KENDİ TRANSACTION'INDA — yarım uygulanmış şema olmaz.
    await shared.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        for (const stmt of splitSqlStatements(m.sql)) {
          await tx.$executeRawUnsafe(stmt);
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO "${schema}"."schema_migrations" (version, name, checksum) VALUES ($1, $2, $3)`,
          m.version,
          m.name,
          m.checksum,
        );
      },
      { timeout: 120_000 },
    );
    applied.push(m.version);
  }

  return { schema, applied, alreadyCurrent: false };
}

async function hasLedger(shared: SharedClient, schema: string): Promise<boolean> {
  return tableExists(shared, schema, "schema_migrations");
}

async function hasTables(shared: SharedClient, schema: string): Promise<boolean> {
  return tableExists(shared, schema, "audit_entries");
}

async function tableExists(
  shared: SharedClient,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await shared.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    schema,
    table,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Bir şemanın bekleyen migration'ları — uygulamadan sorar. */
export async function pendingMigrations(
  shared: SharedClient,
  schema: string,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<readonly Migration[]> {
  const already = await appliedMigrations(shared, schema);
  const done = new Set(already.map((a) => a.version));
  return migrations.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
}
