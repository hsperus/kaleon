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
      for (const t of rows) console.log(`${t.slug}  ${t.name}  [${t.status}]  ${t.schemaName}  ${t.id}`);
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
          "  npm run tenant -- drop <slug>",
        ].join("\n"),
      );
  }
}

await main().finally(() => disconnectAll());
