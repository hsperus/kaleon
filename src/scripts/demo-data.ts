/**
 * Demo verisi kurar.
 *
 *   npm run demo:data -- <slug> [sektör]
 *
 * Asıl iş `src/modules/demo/seed.ts` içinde: aynı tohumlama hem bu
 * scriptten hem de demo kayıt ucundan çağrılıyor. İki ayrı kopya
 * olsaydı biri güncellenir, diğeri unutulur ve denemeye gelen kişi
 * bizim gördüğümüzden farklı bir ürün görürdü.
 */

import { disconnectAll, sharedClient, tenantClient } from "../db/client.js";
import { seedDemoTenant } from "../modules/demo/seed.js";
import { SECTORS } from "../modules/demo/sectors.js";

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "demo";
  const sector = process.argv[3] ?? null;

  if (sector && !SECTORS.some((s) => s.id === sector)) {
    console.error(`Bilinmeyen sektör: ${sector}`);
    console.error(`Seçenekler: ${SECTORS.map((s) => s.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const shared = sharedClient();
  const tenant = await shared.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`Tenant bulunamadı: ${slug}`);
    process.exitCode = 1;
    return;
  }

  const db = tenantClient(tenant.schemaName);
  await seedDemoTenant(db as never, {
    companyName: tenant.name,
    sector: sector ?? tenant.sector,
  });

  console.log(`✓ ${tenant.slug}: demo verisi hazır (${sector ?? tenant.sector ?? "makina"})`);
  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  await disconnectAll();
});
