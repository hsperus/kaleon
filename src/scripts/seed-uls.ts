/**
 * ULS Havayolları Kargo demo verisi.
 *
 *   npm run seed:uls -- [slug]
 *
 * Genel sektör tohumlaması imalatçı için yazıldı; hava kargoda satılan
 * şey bir nesne değil kapasitedir. Bu script o farkı kuran ayrı bir
 * veri kümesi yazar.
 */

import { disconnectAll, sharedClient, tenantClient } from "../db/client.js";
import { seedUls } from "../modules/demo/uls-seed.js";

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "uls";
  const db = sharedClient();
  const tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`Tenant bulunamadı: ${slug}`);
    process.exitCode = 1;
    return;
  }

  const r = await seedUls(tenantClient(tenant.schemaName) as never);

  console.log(`\n═══ ${tenant.name} · hava kargo verisi ═══`);
  for (const line of r.done) console.log(`  ✓ ${line}`);
  for (const f of r.failed) console.log(`  ✗ ${f.adim}: ${f.sebep}`);
  console.log("");

  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  await disconnectAll();
});
