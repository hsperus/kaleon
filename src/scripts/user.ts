/**
 * Kullanıcı yönetimi CLI'ı.
 *
 * Parola arayüzden değil buradan atanır: ilk yönetici hesabını kuran bir
 * web formu, kurulumdan sonra kapatılmayı unutulan bir arka kapıdır.
 *
 *   npm run user -- create <e-posta> "<Ad Soyad>" <parola>
 *   npm run user -- grant  <e-posta> <tenant-slug> <rol> [rol...]
 *   npm run user -- totp   <e-posta>            # 2FA açar, sırrı yazar
 *   npm run user -- revoke <e-posta>            # tüm oturumlarını düşürür
 *   npm run user -- list
 */

import { hashPassword } from "../auth/password.js";
import { generateSecret, otpauthUri } from "../auth/totp.js";
import { issueResetCode } from "../auth/password-reset.js";
import { PrismaAuthStore } from "../db/auth-store.js";
import { sharedClient, disconnectAll } from "../db/client.js";
import { ROLE_PERMISSIONS } from "../kernel/rbac.js";

const db = sharedClient();

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function findUser(email: string) {
  const user = await db.user.findUnique({ where: { email: email.toLocaleLowerCase("tr") } });
  return user ?? fail(`Kullanıcı yok: ${email}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "create": {
      const [email, displayName, password] = args;
      if (!email || !displayName || !password) fail('Kullanım: create <e-posta> "<Ad Soyad>" <parola>');
      const user = await db.user.create({
        data: {
          email: email.toLocaleLowerCase("tr"),
          displayName,
          passwordHash: await hashPassword(password),
        },
      });
      console.log(`✓ Kullanıcı oluşturuldu: ${user.email} (${user.id})`);
      console.log("  Henüz hiçbir tenant'ta üyeliği yok — 'grant' ile rol verin.");
      break;
    }

    case "grant": {
      const [email, slug, ...roles] = args;
      if (!email || !slug || roles.length === 0) fail("Kullanım: grant <e-posta> <tenant-slug> <rol...>");
      const unknown = roles.filter((r) => !(r in ROLE_PERMISSIONS));
      if (unknown.length > 0) {
        fail(`Bilinmeyen rol: ${unknown.join(", ")}. Geçerli: ${Object.keys(ROLE_PERMISSIONS).join(", ")}`);
      }
      const user = await findUser(email);
      const tenant = (await db.tenant.findUnique({ where: { slug } })) ?? fail(`Tenant yok: ${slug}`);
      await db.membership.upsert({
        where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
        create: { userId: user.id, tenantId: tenant.id, roles },
        update: { roles, isActive: true },
      });
      console.log(`✓ ${user.email} → ${tenant.slug}: ${roles.join(", ")}`);
      break;
    }

    case "totp": {
      const [email] = args;
      if (!email) fail("Kullanım: totp <e-posta>");
      const user = await findUser(email);
      const secret = generateSecret();
      await db.user.update({ where: { id: user.id }, data: { totpSecret: secret, lastTotpStep: null } });
      console.log(`✓ 2FA açıldı: ${user.email}`);
      console.log(`  Sır: ${secret}`);
      console.log(`  URI: ${otpauthUri({ secret, account: user.email, issuer: "KAELON" })}`);
      break;
    }

    case "reset": {
      const [email] = args;
      if (!email) fail("Kullanım: reset <e-posta>");
      const user = await findUser(email);
      const { code, expiresAt } = await issueResetCode(new PrismaAuthStore(db), {
        userId: user.id,
        issuedBy: null,
      });
      console.log(`✓ Sıfırlama kodu üretildi: ${user.email}`);
      console.log("");
      console.log(`    ${code}`);
      console.log("");
      console.log(`  Geçerlilik: ${new Date(expiresAt).toLocaleString("tr-TR")} (1 saat)`);
      console.log("  Tek kullanımlık. Kullanıcı giriş ekranında 'Parolamı unuttum' ile girer.");
      console.log("  Sıfırlandığında kullanıcının TÜM oturumları düşer.");
      break;
    }

    case "revoke": {
      const [email] = args;
      if (!email) fail("Kullanım: revoke <e-posta>");
      const user = await findUser(email);
      const n = await new PrismaAuthStore(db).revokeAllForUser(user.id, new Date().toISOString());
      console.log(`✓ ${n} oturum düşürüldü: ${user.email}`);
      break;
    }

    case "list": {
      const users = await db.user.findMany({
        include: { memberships: { include: { tenant: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (users.length === 0) console.log("(kullanıcı yok)");
      for (const u of users) {
        const flags = [u.isActive ? "aktif" : "PASİF", u.totpSecret ? "2FA" : "2FA yok"].join(", ");
        console.log(`${u.email}  ${u.displayName}  [${flags}]`);
        for (const m of u.memberships) {
          console.log(`    ${m.tenant.slug}: ${m.roles.join(", ")}${m.isActive ? "" : " (pasif)"}`);
        }
      }
      break;
    }

    default:
      console.log(
        [
          "Kullanım:",
          '  npm run user -- create <e-posta> "<Ad Soyad>" <parola>',
          "  npm run user -- grant  <e-posta> <tenant-slug> <rol...>",
          "  npm run user -- totp   <e-posta>",
          "  npm run user -- reset  <e-posta>              # parola sıfırlama kodu",
          "  npm run user -- revoke <e-posta>",
          "  npm run user -- list",
        ].join("\n"),
      );
  }
}

await main().finally(() => disconnectAll());
