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

/*
 * HAVUZLAR `globalThis` ÜZERİNDE TUTULUR.
 *
 * Modül seviyesindeki bir değişken "tekil" değildir: Next.js geliştirme
 * modunda her sıcak yeniden yüklemede modülü atıp yeniden değerlendirir.
 * Değişken sıfırlanır ama ESKİ istemcinin bağlantı havuzu açık kalır —
 * kimse kapatmaz, çünkü ona ulaşan referans kalmamıştır.
 *
 * Elli altı dakikalık bir geliştirme oturumunda bu, Postgres'in
 * `max_connections` sınırını doldurdu ve uygulama "sorry, too many
 * clients already" ile tamamen durdu.
 *
 * `globalThis` yeniden değerlendirmeyi atlatır; aynı süreçte ikinci bir
 * havuz açılmaz. Üretimde modül zaten bir kez değerlendirilir, dolayısıyla
 * bu ek katman orada bir şey değiştirmez — zararı da yoktur.
 */
interface PrismaGlobals {
  shared?: SharedPrisma;
  tenants?: Map<string, TenantPrisma>;
}
const g = globalThis as typeof globalThis & { __kaelonPrisma?: PrismaGlobals };
g.__kaelonPrisma ??= {};
const pools = g.__kaelonPrisma;

export function sharedClient(): SharedPrisma {
  pools.shared ??= new SharedPrisma();
  return pools.shared;
}

/** Bağlantı dizesinin `schema` parametresini hedef şemayla değiştirir. */
export function urlForSchema(baseUrl: string, schema: string): string {
  assertSafeSchemaName(schema);
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);

  return url.toString();
}

pools.tenants ??= new Map<string, TenantPrisma>();
const tenantPool = pools.tenants;

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
  if (pools.shared) {
    await pools.shared.$disconnect();
    delete pools.shared;
  }
}
