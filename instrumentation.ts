/**
 * Sunucu açılışı.
 *
 * Next.js bu dosyayı süreç başına BİR KEZ, ilk istekten önce çalıştırır.
 * Ortam doğrulaması için doğru yer burasıdır: bir isteğin ortasında
 * "veritabanı ayarı yokmuş" demek çok geçtir — o noktada kullanıcı zaten
 * hata ekranına bakıyordur ve sebebini kimse anlamaz.
 */

export async function register(): Promise<void> {
  // Yalnızca Node.js çalışma zamanında; edge middleware'de process.env
  // farklıdır ve veritabanı ayarları oraya ait değildir.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const { assertEnv } = await import("./src/server/env.js");
  const report = assertEnv();

  if (report.production && report.warnings.length > 0) {
    console.warn(
      `[KAELON] ${report.warnings.length} uyarı ile üretimde başlatıldı. ` +
        `Bunlar bilinçli seçimler olmalı.`,
    );
  }
}
