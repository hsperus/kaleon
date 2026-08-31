/**
 * Zamanlanmış izleme koşusu — NÖBETÇİYİ GERÇEKTEN NÖBETE ÇIKARIR.
 *
 * İZLEME KURALLARI VARDI, ONLARI ÇALIŞTIRAN YOKTU.
 *
 * `watches` tablosu tanımlanabiliyordu ve kurallar yalnızca kullanıcı
 * uygulamayı AÇTIĞINDA değerlendiriliyordu — yani "bakiye 500.000'in
 * altına düşerse bildir" kuralı, kullanıcı zaten bakmaya geldiğinde
 * çalışıyordu. İzlemenin bütün amacı, kimse bakmıyorken bakmaktır.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * BU BETİK BİLDİRİM GÖNDERMEZ, KAYIT TUTAR.
 *
 * E-posta ya da SMS kanalı henüz yok ve olmayan bir kanalı varmış
 * gibi kurmak, tetiklenen uyarının kaybolduğu bir sistem üretirdi.
 * Sonuçlar `watches.last_*` alanlarına yazılıyor; kullanıcı girdiğinde
 * brifingde görüyor. Kanal eklendiğinde tetikleme noktası hazır.
 *
 * HER KULLANICI KENDİ YETKİSİYLE KOŞAR. İzleme sahibinin göremediği
 * bir veriyi izleme de göremez; aksi hâlde depo sorumlusunun kurduğu
 * bir kural, patronun rakamlarını sızdırırdı.
 *
 *   npm run watch:run
 */

import { disconnectAll, sharedClient, tenantClient } from "../db/client.js";
import { WatchRepository } from "../db/watch-repository.js";
import { evaluateWatch } from "../modules/briefing/watch.js";
import { invokeTool } from "../kernel/invoke.js";
import { createPrincipal } from "../kernel/rbac.js";
import { buildRegistry } from "../app.js";
import { PrismaDataSource } from "../db/master-data-source.js";
import { InMemoryAuditSink } from "../kernel/audit.js";
import type { RoleId } from "../kernel/types.js";

interface Sonuc {
  readonly tenant: string;
  readonly watch: string;
  readonly fired: boolean;
  readonly value: number | null;
  readonly problem: string | null;
}

async function main(): Promise<void> {
  const shared = sharedClient();
  const tenants = await shared.tenant.findMany({ select: { id: true, slug: true, schemaName: true } });
  const sonuclar: Sonuc[] = [];

  for (const t of tenants) {
    const db = tenantClient(t.schemaName);
    const watches = new WatchRepository(db);
    const aktif = await watches.allActive();
    if (aktif.length === 0) continue;

    /*
     * KATALOG KİRACI BAŞINA BİR KEZ KURULUR.
     *
     * Her izleme için yeniden kurmak, aynı kiracıda on izleme varsa
     * on kez bağlantı havuzu açardı — ve bu projede bir kez tam
     * olarak o yüzden Postgres bağlantıları tükendi.
     */
    const registry = buildRegistry(new PrismaDataSource(db as never), { tenantDb: db } as never);
    const audit = new InMemoryAuditSink();

    for (const w of aktif) {
      const uye = await shared.membership.findFirst({
        where: { userId: w.ownerUserId, tenantId: t.id },
        select: { roles: true, isActive: true },
      });
      if (!uye || !uye.isActive) {
        // Sahibi artık bu şirkette değil: izleme çalıştırılmaz.
        // Silinmiyor da — sahibi geri dönebilir ve kuralı yeniden
        // yazmak zorunda kalmamalı.
        sonuclar.push({
          tenant: t.slug,
          watch: w.name,
          fired: false,
          value: null,
          problem: "sahibi bu şirkette aktif değil",
        });
        continue;
      }

      const principal = createPrincipal({
        userId: w.ownerUserId,
        tenantId: t.id,
        roles: uye.roles as RoleId[],
      });

      const invoked = await invokeTool(w.tool, w.input, {
        registry,
        audit,
        principal,
        tenant: { tenantId: t.id, schema: t.schemaName, slug: t.slug } as never,
        correlationId: `watch-run-${w.id}`,
        // Zamanlanmış koşu bir işin kanalıdır: sohbet değil, arayüz değil.
        channel: "job",
      });

      if (!invoked.outcome.ok) {
        sonuclar.push({
          tenant: t.slug,
          watch: w.name,
          fired: false,
          value: null,
          problem: `${w.tool} çalışmadı (${invoked.outcome.code})`,
        });
        continue;
      }

      const outcome = evaluateWatch(w, invoked.outcome.data);
      await watches.recordCheck(w.id, outcome.value, outcome.fired).catch(() => {
        // Kayıt tutulamazsa koşu devam etsin: bir izlemenin defteri
        // tutulamadı diye diğerleri hiç çalışmasın istemeyiz.
      });

      sonuclar.push({
        tenant: t.slug,
        watch: w.name,
        fired: outcome.fired,
        value: outcome.value,
        problem: outcome.value === null ? (outcome.reason ?? "değer okunamadı") : null,
      });
    }
  }

  const tetiklenen = sonuclar.filter((s) => s.fired);
  const sorunlu = sonuclar.filter((s) => s.problem !== null);

  console.log(`\nKAELON · İzleme koşusu — ${new Date().toISOString()}`);
  console.log("──────────────────────────────────────────────");
  console.log(`Değerlendirilen : ${sonuclar.length}`);
  console.log(`Tetiklenen      : ${tetiklenen.length}`);
  console.log(`Sorunlu         : ${sorunlu.length}`);

  for (const s of tetiklenen) {
    console.log(`  ! ${s.tenant} · ${s.watch} = ${s.value}`);
  }
  /*
   * SORUNLU İZLEME SESSİZ KALMAZ.
   *
   * Çalışmayan bir nöbetçi, olmayan bir nöbetçiden daha tehlikelidir:
   * kullanıcı korunduğunu sanar.
   */
  for (const s of sorunlu) {
    console.log(`  ✗ ${s.tenant} · ${s.watch}: ${s.problem}`);
  }

  await disconnectAll();

  /*
   * SORUNLU İZLEME, BAŞARISIZ KOŞU DEĞİLDİR.
   *
   * Önce sorunlu izleme varsa çıkış kodu 1 dönüyordu ve systemd her
   * saat "Failed to start kaelon-watch.service" yazıyordu. Oysa koşu
   * çalıştı: yirmi izlemeden ikisinin sahibi ayrılmışsa, o bir
   * bulgudur, arıza değil.
   *
   * Bu, başka yerlerde kaçındığımız hatanın ta kendisi: her saat
   * gelen bir alarm, birkaç haftada tamamen görünmez olur ve gerçek
   * arıza da onunla birlikte kaybolur.
   *
   * Çıkış kodu yalnızca KOŞUNUN KENDİSİ çökerse sıfır dışıdır —
   * bunu da yakalanmamış istisna zaten yapar. Bulgular günlüğe
   * yazılıyor ve tetiklenen izlemeler brifingde görünüyor.
   */
  process.exitCode = 0;
}

await main();
