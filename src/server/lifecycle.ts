/**
 * Süreç yaşam döngüsü: düzgün kapanma ve bakım işleri.
 *
 * DÜZGÜN KAPANMA NEDEN GEREKLİ:
 * Dağıtım sırasında konteynere SIGTERM gelir. Hiçbir şey yapılmazsa süreç
 * anında ölür ve o an akan istekler yarıda kalır — kullanıcı "kaydettim
 * ama gitmemiş" der. Daha kötüsü, açık veritabanı bağlantıları düzgün
 * kapanmadığı için Postgres tarafında bir süre boşta kalırlar ve yeni
 * sürüm bağlantı havuzunu doldurmakta zorlanır.
 *
 * BU DOSYA VERİTABANINI TANIMAZ — VE BU BİLİNÇLİDİR.
 * `instrumentation.ts` Next.js tarafından hem Node hem edge çalışma zamanı
 * için derlenir. Buradan Prisma'ya uzanan bir import zinciri, edge paketine
 * `path` gibi Node modüllerini sürükler ve UYGULAMA HİÇ AÇILMAZ. (Gerçekten
 * yaşandı: sunucu 500 döndü, sebebi "Module not found: Can't resolve 'path'"
 * idi.) Veritabanına dokunan bakım işi ayrı bir dosyada ve yalnızca Node
 * tarafındaki istek yolundan başlatılır.
 */

import { log } from "./log.js";

/** Kapanırken akan isteklere tanınan süre. */
const DRAIN_TIMEOUT_MS = 10_000;

let started = false;

/** Kapanışta çalıştırılacak temizlikler (bağlantı kapatma vb.). */
const cleanups: (() => Promise<void>)[] = [];

/** Veritabanı gibi Node'a özgü kaynaklar kendi temizliğini buraya kaydeder. */
export function onShutdown(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

export function startLifecycle(): void {
  if (started) return;
  started = true;

  const shutdown = (signal: string) => {
    log.info("kapanma sinyali alındı", { signal });

    // Süresiz bekleme yok: kapanamayan bir süreç dağıtımı kilitler ve
    // orkestratör onu SIGKILL ile öldürür — o noktada hiçbir temizlik
    // yapılamaz.
    const timer = setTimeout(() => {
      log.warn("kapanma zaman aşımı; süreç zorla sonlandırılıyor", {
        durationMs: DRAIN_TIMEOUT_MS,
      });
      process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    timer.unref?.();

    void Promise.all(cleanups.map((fn) => fn()))
      .then(() => {
        log.info("kaynaklar kapatıldı, süreç sonlanıyor");
        process.exit(0);
      })
      .catch((e) => {
        log.error("kapanışta kaynaklar kapatılamadı", { error: (e as Error).message });
        process.exit(1);
      });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // Yakalanmamış hata süreci belirsiz bir duruma sokar. Loglayıp kapanmak,
  // bilinmeyen durumda çalışmaya devam etmekten güvenlidir.
  process.on("unhandledRejection", (reason) => {
    log.error("yakalanmamış promise reddi", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on("uncaughtException", (error) => {
    log.fail("yakalanmamış istisna", error);
    shutdown("uncaughtException");
  });
}
