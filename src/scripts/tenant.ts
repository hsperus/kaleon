/**
 * Tenant yönetimi CLI'ı.
 *
 * Bir tenant iki parçadır ve İKİSİ DE olmadan tenant yoktur: kontrol
 * düzlemindeki kayıt (kim, hangi şema) ve o şemanın kendisi. Bu komut
 * ikisini birlikte kurar; yarım kalmış kurulum en can sıkıcı hata sınıfıdır.
 *
 *   npm run tenant -- create <slug> "<Şirket Adı>"
 *   npm run tenant -- list
 *   npm run tenant -- drop <slug>      # KVKK silme — geri dönüşü yok
 */

import { disconnectAll, sharedClient } from "../db/client.js";
import { dropTenantSchema, provisionTenantSchema, tenantSchemaName } from "../db/provision.js";
import { appliedMigrations, migrateTenant, pendingMigrations } from "../db/migrate.js";

const db = sharedClient();

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "create": {
      const [slug, name] = args;
      if (!slug || !name) {
        console.error('Kullanım: create <slug> "<Şirket Adı>"');
        process.exitCode = 1;
        return;
      }
      const schema = tenantSchemaName(slug);
      const result = await provisionTenantSchema(db, slug);
      const tenant = await db.tenant.upsert({
        where: { slug },
        create: { slug, name, schemaName: schema, status: "active" },
        update: { name, status: "active" },
      });
      console.log(`✓ Tenant: ${tenant.slug} (${tenant.id})`);
      console.log(`  Şema: ${schema} ${result.created ? "(oluşturuldu)" : "(zaten kuruluydu)"}`);
      break;
    }

    case "list": {
      const rows = await db.tenant.findMany({ orderBy: { createdAt: "asc" } });
      if (rows.length === 0) console.log("(tenant yok)");
      for (const t of rows) {
        const pending = await pendingMigrations(db, t.schemaName).catch(() => []);
        const applied = await appliedMigrations(db, t.schemaName).catch(() => []);
        const version = applied.at(-1)?.version ?? 0;
        const flag = pending.length > 0 ? `  ⚠ ${pending.length} migration bekliyor` : "";
        console.log(
          `${t.slug}  ${t.name}  [${t.status}]  ${t.schemaName}  v${version}${flag}`,
        );
      }
      break;
    }

    /**
     * Bekleyen şema değişikliklerini uygular.
     *
     * TÜM TENANT'LAR TEK KOMUTLA güncellenir; tek tek uygulamak, birinin
     * unutulması demektir ve unutulan tenant eksik tabloyla çalışır.
     * Bir tenant patlarsa diğerleri denenmeye DEVAM EDER ve rapor sonda
     * toplanır — ilk hatada durmak, kalanları görünmez kılardı.
     */
    case "migrate": {
      const [target] = args;
      const tenants = await db.tenant.findMany({
        where: target && target !== "--all" ? { slug: target } : {},
        orderBy: { createdAt: "asc" },
      });
      if (tenants.length === 0) {
        console.error(target ? `Tenant yok: ${target}` : "(tenant yok)");
        process.exitCode = 1;
        return;
      }

      const failures: string[] = [];
      for (const t of tenants) {
        try {
          const r = await migrateTenant(db, t.schemaName);
          console.log(
            r.applied.length === 0
              ? `= ${t.slug}: güncel`
              : `✓ ${t.slug}: ${r.applied.join(", ")} uygulandı`,
          );
        } catch (e) {
          failures.push(t.slug);
          console.error(`✗ ${t.slug}: ${(e as Error).message}`);
        }
      }
      if (failures.length > 0) {
        console.error(`\n${failures.length} tenant güncellenemedi: ${failures.join(", ")}`);
        process.exitCode = 1;
      }
      break;
    }

    case "drop": {
      const [slug] = args;
      if (!slug || process.env["KAELON_CONFIRM_DROP"] !== slug) {
        console.error(
          `Bu komut ${slug ?? "<slug>"} tenant'ının TÜM işletmesel verisini siler.\n` +
            `Onaylamak için: KAELON_CONFIRM_DROP=${slug ?? "<slug>"} npm run tenant -- drop ${slug ?? "<slug>"}`,
        );
        process.exitCode = 1;
        return;
      }
      const tenant = await db.tenant.findUnique({ where: { slug } });
      if (!tenant) {
        console.error(`Tenant yok: ${slug}`);
        process.exitCode = 1;
        return;
      }
      await dropTenantSchema(db, tenant.schemaName);
      await db.tenant.update({ where: { slug }, data: { status: "archived" } });
      console.log(`✓ ${slug} şeması silindi, kayıt 'archived' olarak işaretlendi.`);
      break;
    }

    default:
      console.log(
        [
          "Kullanım:",
          '  npm run tenant -- create <slug> "<Şirket Adı>"',
          "  npm run tenant -- list",
          "  npm run tenant -- migrate [slug|--all]",
          "  npm run tenant -- drop <slug>",
        ].join("\n"),
      );
  }
}

await main().finally(() => disconnectAll());
