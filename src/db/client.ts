/**
 * Tenant-scoped Prisma client fabrikası.
 *
 * Uygulama kodu şema adını ASLA elle yazmaz. Tenant'a bağlanmanın tek yolu
 * `tenantClient(schema)`'dır; bağlantı dizesindeki `?schema=` parametresi
 * search_path'i tek şemaya sabitler. Bir tenant client'ı başka bir şemayı
 * göremez — izolasyon sorgu yazarının dikkatine değil, bağlantıya bağlıdır.
 */

import { PrismaClient as SharedPrisma } from "./generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "./generated/tenant/index.js";
import { assertSafeSchemaName } from "./provision.js";

export type SharedDb = SharedPrisma;
export type TenantDb = TenantPrisma;

let sharedSingleton: SharedPrisma | null = null;

export function sharedClient(): SharedPrisma {
  sharedSingleton ??= new SharedPrisma();
  return sharedSingleton;
}

/** Bağlantı dizesinin `schema` parametresini hedef şemayla değiştirir. */
export function urlForSchema(baseUrl: string, schema: string): string {
  assertSafeSchemaName(schema);
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

const tenantPool = new Map<string, TenantPrisma>();

/**
 * Tenant client'ı — şema başına havuzlanır.
 *
 * Not: her şema ayrı bir bağlantı havuzu açar. Yüzlerce tenant'ta bu havuz
 * sayısı sorun olur; o ölçekte PgBouncer veya row-level security'ye geçilir
 * (BUILD-PLAN Aşama 1 notu). PMF'e kadar schema-per-tenant yeterlidir.
 */
export function tenantClient(schema: string, baseUrl = process.env["TENANT_DATABASE_URL"]): TenantPrisma {
  assertSafeSchemaName(schema);
  const cached = tenantPool.get(schema);
  if (cached) return cached;

  if (!baseUrl) {
    throw new Error("TENANT_DATABASE_URL tanımlı değil.");
  }
  const client = new TenantPrisma({
    datasources: { db: { url: urlForSchema(baseUrl, schema) } },
  });
  tenantPool.set(schema, client);
  return client;
}

/** Test ve kapanış için — açık tüm bağlantıları kapatır. */
export async function disconnectAll(): Promise<void> {
  await Promise.all([...tenantPool.values()].map((c) => c.$disconnect()));
  tenantPool.clear();
  if (sharedSingleton) {
    await sharedSingleton.$disconnect();
    sharedSingleton = null;
  }
}
