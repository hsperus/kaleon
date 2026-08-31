/**
 * Bir tenant'ı denemeye hazır hâle getirir: kullanıcı + zengin veri.
 *
 *   npm run setup -- <slug> <e-posta> "<Ad Soyad>" [sektör]
 *
 * PAROLA BURADA BELİRLENMEZ. Kullanıcı tek kullanımlık bir kodla kendi
 * parolasını koyar. Bu bir zahmet değil, tasarımın kendisi: yöneticinin
 * kullanıcı için parola yazması, o parolanın yönetici tarafından
 * bilinmesi demektir — ve çoğu yönetici herkese aynı parolayı verir.
 *
 * KOD TEK KULLANIMLIK VE SÜRELİDİR. Ekranda bir kez görünür; kaybolursa
 * yenisi üretilir. Kanal olarak telefon/WhatsApp kullanılır çünkü bu
 * kurulumda e-posta altyapısı yok.
 */

import { disconnectAll, sharedClient, tenantClient } from "../db/client.js";
import { seedDemoTenant } from "../modules/demo/seed.js";
import { seedRichTenant } from "../modules/demo/rich-seed.js";
import { SECTORS } from "../modules/demo/sectors.js";
import { PrismaAuthStore } from "../db/auth-store.js";
import { issueResetCode } from "../auth/password-reset.js";
import { hashPassword } from "../auth/password.js";

async function main(): Promise<void> {
  const [slug, email, name, sector] = process.argv.slice(2);
  if (!slug || !email || !name) {
    console.error('Kullanım: setup -- <slug> <e-posta> "<Ad Soyad>" [sektör]');
    console.error(`Sektörler: ${SECTORS.map((s) => s.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const db = sharedClient();
  const tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`Tenant bulunamadı: ${slug}`);
    process.exitCode = 1;
    return;
  }

  const sekt = sector ?? tenant.sector ?? SECTORS[0]!.id;
  if (!SECTORS.some((s) => s.id === sekt)) {
    console.error(`Bilinmeyen sektör: ${sekt}`);
    process.exitCode = 1;
    return;
  }

  // ── 1. Kullanıcı ──
  const mail = email.trim().toLocaleLowerCase("tr");
  const throwaway = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
  const user = await db.user.upsert({
    where: { email: mail },
    create: { email: mail, displayName: name, passwordHash: throwaway },
    update: { displayName: name, isActive: true },
  });
  await db.membership.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
    create: { userId: user.id, tenantId: tenant.id, roles: ["patron"] },
    update: { roles: ["patron"], isActive: true },
  });

  // ── 2. Veri ──
  const tdb = tenantClient(tenant.schemaName);
  await seedDemoTenant(tdb as never, {
    companyName: tenant.name,
    sector: sekt,
    city: "İstanbul",
    revenueBand: "50-250m",
    exportCurrency: "EUR",
  });
  const rich = await seedRichTenant(tdb as never, { sector: sekt, ownerUserId: user.id });

  // ── 3. Profil ──
  await db.tenant.update({
    where: { id: tenant.id },
    data: { sector: sekt, exportCurrency: "EUR" },
  });

  // ── 4. Giriş kodu ──
  const { code } = await issueResetCode(new PrismaAuthStore(db), {
    userId: user.id,
    issuedBy: user.id,
  });

  console.log("");
  console.log("═══ KURULUM TAMAM ═══");
  console.log(`  Şirket   : ${tenant.name} (${slug}) · sektör: ${sekt}`);
  console.log(`  Kullanıcı: ${name} <${mail}> · rol: Patron`);
  console.log(`  İLK GİRİŞ KODU: ${code}`);
  console.log("");
  console.log("  Kurulan veri:");
  for (const line of rich.done) console.log(`    ✓ ${line}`);
  for (const f of rich.failed) console.log(`    ✗ ${f.module}: ${f.reason}`);
  console.log("");

  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  await disconnectAll();
});
