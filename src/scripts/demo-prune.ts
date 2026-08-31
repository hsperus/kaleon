/**
 * Süresi dolmuş demo ortamlarını siler.
 *
 *   npm run demo:prune [--dry]
 *
 * NEDEN GEREKLİ: süresiz bir demo, aylar sonra kimsenin sahiplenmediği,
 * gerçek kişisel veri taşıyan bir şemadır. KVKK açısından "sakladık
 * çünkü silmeyi unuttuk" savunulabilir bir gerekçe değil.
 *
 * ÜÇ ŞEY SİLİNİR, BİRİ KALIR:
 *   silinir → Postgres şeması, tenant kaydı, oturumlar ve üyelikler
 *   kalır   → demo talebi (şirket, sektör, iletişim)
 *
 * Talep kaydı satış takibi için kalır ama TENANT BAĞI KOPARILIR: artık
 * var olmayan bir tenant'a işaret eden bir kayıt yanıltıcıdır. Kişi
 * "bilgimi silin" derse bu kayıt ayrıca silinir — o yüzden ayrı tabloda.
 *
 * GÜNLÜK CRON'A BAĞLANIR. Elle çalıştırılan bir temizlik, çalıştırılmayan
 * bir temizliktir.
 */

import { disconnectAll, sharedClient } from "../db/client.js";
import { dropTenantSchema } from "../db/provision.js";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const db = sharedClient();

  const expired = await db.tenant.findMany({
    where: { isDemo: true, expiresAt: { lte: new Date() } },
    orderBy: { expiresAt: "asc" },
  });

  if (expired.length === 0) {
    console.log("süresi dolmuş demo yok");
    await disconnectAll();
    return;
  }

  for (const t of expired) {
    const yas = Math.round((Date.now() - (t.expiresAt?.getTime() ?? 0)) / 86_400_000);
    if (dry) {
      console.log(`[kuru] ${t.slug} — süresi ${yas} gün önce doldu`);
      continue;
    }

    /*
     * SIRA ÖNEMLİ: önce şema, sonra kayıtlar.
     *
     * Tenant kaydı önce silinseydi ve şema düşürme patlasaydı, artık
     * hiçbir kayıtla ilişkilendirilemeyen bir şema kalırdı — kimsenin
     * bulamayacağı ve dolayısıyla asla silinmeyecek bir şema.
     */
    // ŞEMA ADIYLA: slug göndermek sessizce başarısız oluyordu ve
    // tenant kaydı silinirken şema kalıyordu. `dropTenantSchema`
    // artık ikisini de kabul ediyor ama açık olan doğrusu bu.
    await dropTenantSchema(db, t.schemaName);
    await db.session.deleteMany({ where: { tenantId: t.id } });
    await db.membership.deleteMany({ where: { tenantId: t.id } });
    // Talep kaydı kalır ama artık var olmayan tenant'a işaret etmez.
    await db.demoRequest.updateMany({ where: { tenantId: t.id }, data: { tenantId: null } });
    await db.tenant.delete({ where: { id: t.id } });

    console.log(`✓ silindi: ${t.slug} (${t.name}) — süresi ${yas} gün önce doldu`);
  }

  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  await disconnectAll();
});
