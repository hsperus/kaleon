/**
 * Tenant provisioning — schema-per-tenant.
 *
 * Her müşteri kendi Postgres şemasına sahiptir. Bu, Mimari v1 §6.2'deki
 * kararın uygulamasıdır ve dört şeyi birden verir:
 *   - tam veri izolasyonu (yanlışlıkla başka tenant'ın verisi gelmez),
 *   - tenant başına backup/restore,
 *   - KVKK silme talebi = şema DROP,
 *   - büyük müşteri başkasını yavaşlatmaz.
 *
 * Tenant DDL'i `prisma/tenant-template.sql` dosyasından gelir ve bu dosya
 * `prisma migrate diff` ile ÜRETİLİR — elle yazılmaz, dolayısıyla Prisma
 * modelleriyle arasında drift oluşmaz.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient as SharedClient } from "./generated/shared/index.js";
import { migrateTenant } from "./migrate.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Şema adı doğrudan SQL'e girdiği için beyaz liste zorunludur. */
const SCHEMA_NAME_RE = /^tenant_[a-z0-9_]{2,40}$/;

export function tenantSchemaName(slug: string): string {
  const normalized = slug
    .toLocaleLowerCase("tr")
    .replace(/[ğ]/g, "g")
    .replace(/[ü]/g, "u")
    .replace(/[ş]/g, "s")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ç]/g, "c")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const name = `tenant_${normalized}`;
  assertSafeSchemaName(name);
  return name;
}

export function assertSafeSchemaName(schema: string): void {
  if (!SCHEMA_NAME_RE.test(schema)) {
    throw new Error(
      `Güvensiz şema adı: "${schema}". Kural: tenant_ öneki + küçük harf/rakam/alt çizgi.`,
    );
  }
}

let cachedDdl: string | null = null;

/** Üretilmiş tenant DDL'i; `CREATE SCHEMA public` satırı ayıklanır. */
export function tenantDdl(): string {
  if (cachedDdl) return cachedDdl;
  const raw = readFileSync(join(here, "../../prisma/tenant-template.sql"), "utf8");
  cachedDdl = raw
    .split("\n")
    .filter((line) => !/^CREATE SCHEMA IF NOT EXISTS "public"/i.test(line.trim()))
    .join("\n");
  return cachedDdl;
}

/**
 * Audit tablosunu veritabanı seviyesinde değişmez kılar.
 *
 * Uygulama katmanındaki "sadece append" sözü yeterli değildir: bir migration,
 * bir bakım scripti veya doğrudan psql erişimi onu delebilir. Bu tetikleyici
 * UPDATE ve DELETE'i veritabanının kendisinde reddeder.
 */
const AUDIT_IMMUTABILITY_SQL = (schema: string) => `
CREATE OR REPLACE FUNCTION "${schema}".kaelon_audit_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries değiştirilemez veya silinemez (KAELON değişmezi)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON "${schema}"."audit_entries";
CREATE TRIGGER audit_no_update
  BEFORE UPDATE ON "${schema}"."audit_entries"
  FOR EACH ROW EXECUTE FUNCTION "${schema}".kaelon_audit_immutable();

DROP TRIGGER IF EXISTS audit_no_delete ON "${schema}"."audit_entries";
CREATE TRIGGER audit_no_delete
  BEFORE DELETE ON "${schema}"."audit_entries"
  FOR EACH ROW EXECUTE FUNCTION "${schema}".kaelon_audit_immutable();
`;

/**
 * SQL'i tek tek çalıştırılabilir ifadelere böler.
 *
 * Gerekli, çünkü Prisma `$executeRawUnsafe` hazır ifade kullanır ve tek
 * çağrıda birden fazla komut kabul etmez. Bölücü, dolar-tırnaklı gövdeleri
 * ($$ ... $$) ve tek tırnaklı dizeleri tanır — trigger fonksiyonunun içindeki
 * noktalı virgüller yanlışlıkla bölünmesin diye.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let dollarTag: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    // YORUM İÇİNDEKİ NOKTALI VİRGÜL İFADE SONU DEĞİLDİR.
    // Bu ayrım olmadan `-- şema değişikliği; yeni migration yazın` gibi bir
    // açıklama satırı ikiye bölünür ve ikinci yarısı SQL sanılıp çalıştırılır.
    if (inLineComment) {
      buf += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      buf += ch;
      if (ch === "/" && sql[i - 1] === "*") inBlockComment = false;
      continue;
    }

    if (!dollarTag && !inSingle) {
      if (ch === "-" && sql[i + 1] === "-") {
        inLineComment = true;
        buf += ch;
        continue;
      }
      if (ch === "/" && sql[i + 1] === "*") {
        inBlockComment = true;
        buf += ch;
        continue;
      }
    }

    if (dollarTag) {
      buf += ch;
      if (ch === "$" && sql.startsWith(dollarTag, i)) {
        buf += sql.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (inSingle) {
      buf += ch;
      if (ch === "'") inSingle = false;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === "$") {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        buf += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }

    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
      continue;
    }

    buf += ch;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.filter((s) => !/^--/.test(s) || s.includes("\n"));
}

export interface ProvisionResult {
  readonly schema: string;
  readonly created: boolean;
  /** Bu koşuda uygulanan migration numaraları. */
  readonly applied: readonly number[];
}

/**
 * Tenant şemasını kurar veya günceller.
 *
 * KURULUM DA BİR MIGRATION'DIR. Yeni tenant migration 001'den başlar ve
 * hepsini uygular; var olan tenant yalnızca eksiklerini uygular. Tek kod
 * yolu olması önemlidir — iki ayrı yol olsaydı, "yeni kurulan" ile
 * "güncellenmiş" tenant'ın şeması zamanla farklılaşırdı ve bu fark ancak
 * müşteride, açıklanamayan bir hata olarak ortaya çıkardı.
 *
 * Migration sisteminden ÖNCE kurulmuş, defteri olmayan bir şema bulursa
 * SESSİZCE devam etmez ve onu "güncel" diye işaretlemez — hata verir.
 * Yanlış işaretlenmiş bir şema, eksik tabloyla çalışan bir müşteri demektir.
 */
export async function provisionTenantSchema(
  shared: SharedClient,
  slugOrSchema: string,
): Promise<ProvisionResult> {
  const schema = slugOrSchema.startsWith("tenant_")
    ? (assertSafeSchemaName(slugOrSchema), slugOrSchema)
    : tenantSchemaName(slugOrSchema);

  const hasTables = await schemaHasTables(shared, schema);
  const hasLedger = await schemaHasLedger(shared, schema);

  if (hasTables && !hasLedger) {
    throw new Error(
      `${schema}: migration defteri yok ama tablolar var. Bu şema migration ` +
        `sisteminden önce kurulmuş. Hangi sürümde olduğu bilinemez; "güncel" ` +
        `sayılırsa eksik tabloyla çalışır. Verisi yoksa şemayı silip yeniden ` +
        `kurun, varsa elle baseline'layın (migrateTenant(..., { baselineTo })).`,
    );
  }

  const { applied } = await migrateTenant(shared, schema);

  // Denetim kaydı değişmezliği şema adına bağlı olduğu için migration
  // dosyasına konamaz; her koşuda idempotent olarak yeniden uygulanır.
  await shared.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      for (const stmt of splitSqlStatements(AUDIT_IMMUTABILITY_SQL(schema))) {
        await tx.$executeRawUnsafe(stmt);
      }
    },
    { timeout: 60_000 },
  );

  return { schema, created: !hasTables, applied };
}

async function schemaHasTables(shared: SharedClient, schema: string): Promise<boolean> {
  const rows = await shared.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'audit_entries'`,
    schema,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function schemaHasLedger(shared: SharedClient, schema: string): Promise<boolean> {
  const rows = await shared.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'schema_migrations'`,
    schema,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/** KVKK silme talebi — tenant'ın tüm işletmesel verisi tek komutla gider. */
/**
 * Şemayı düşürür — slug ya da şema adıyla.
 *
 * ESKİDEN YALNIZCA ŞEMA ADI KABUL EDİYORDU ve bu bir tuzaktı:
 * `provisionTenantSchema` ikisini de alıyor, bu almıyordu. Kuran ve
 * düşüren fonksiyonun farklı şey beklemesi, her çağıranı yanıltıyor.
 *
 * BEDELİ ÖLÇÜLDÜ. Geliştirme veritabanında 36 YETİM ŞEMA birikmişti:
 * her temizlik çağrısı slug gönderiyor, `assertSafeSchemaName` haklı
 * olarak reddediyor, hata `.catch()` içinde yutuluyor ve tenant kaydı
 * silinirken şema kalıyordu. Üretimdeki gecelik demo temizliği de aynı
 * hatayı taşıyordu — kayıt silinir, şema sonsuza kadar kalırdı. En kötü
 * sonuç: kimsenin bulamayacağı, dolayısıyla asla silinmeyecek bir şema.
 *
 * Artık ikisi de kabul ediliyor ve asimetri kapandı.
 */
export async function dropTenantSchema(
  shared: SharedClient,
  slugOrSchema: string,
): Promise<void> {
  const schema = slugOrSchema.startsWith("tenant_")
    ? (assertSafeSchemaName(slugOrSchema), slugOrSchema)
    : tenantSchemaName(slugOrSchema);
  await shared.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}
