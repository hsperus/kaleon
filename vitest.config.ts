import { defineConfig } from "vitest/config";

/**
 * Test yapılandırması.
 *
 * EŞZAMANLI DOSYA SAYISI SINIRLI — VE BU BİR VERİTABANI KARARIDIR.
 *
 * Kalıcılık testlerinin her biri kendi Prisma client'ını kurar ve
 * Prisma varsayılan olarak çekirdek sayısı × 2 + 1 bağlantı açar. 70
 * test dosyası aynı anda koşunca Postgres'in 100'lük varsayılan
 * sınırı aşılıyor ve testler "too many clients already" ile
 * düşüyordu.
 *
 * İLK ÇÖZÜM DAHA KÖTÜYDÜ VE BURAYA YAZILMASININ SEBEBİ O: bağlantı
 * havuzunu client başına 3'e indirmiştim. Bağlantı sayısı düştü ama
 * BİRDEN FAZLA EŞZAMANLI BAĞLANTI GEREKTİREN testler (kilit testleri,
 * yarış testleri) havuzu tüketip kilitlendi — ve temiz bir hata
 * yerine 16 DAKİKALIK asılmalar üretti. Asılan bir test, düşen bir
 * testten çok daha kötüdür: nedenini kimse aramaz, herkes "yavaş"
 * der ve testler çalıştırılmaz olur.
 *
 * Doğru çözüm, her havuzu boğmak değil AYNI ANDA AÇILAN HAVUZ
 * SAYISINI sınırlamak. 4 dosya × (paylaşılan + tenant client) ×
 * varsayılan havuz ≈ Postgres sınırının altında kalır ve tek bir
 * testin ihtiyaç duyduğu eşzamanlı bağlantı kısıtlanmaz.
 *
 * ÜÇÜNCÜ BİR SEBEP SONRADAN ÇIKTI ve buraya yazılıyor çünkü aynı
 * hata mesajını üretiyor: testler değil, AÇIK DURAN GELİŞTİRME
 * SUNUCUSU bağlantıları tüketebiliyordu. `src/db/client.ts` istemcileri
 * modül seviyesinde tutuyordu; Next.js her sıcak yeniden yüklemede
 * modülü atıp yeniden değerlendirince eski havuz sahipsiz ve açık
 * kalıyordu. Bir saatlik geliştirme oturumu Postgres'i doldurmaya
 * yetiyordu ve test koşusu "too many clients" ile ya düşüyor ya da
 * dakikalarca asılıyordu.
 *
 * Bu yüzden: "too many clients" görünce önce testlere değil, AÇIK
 * NEXT SUNUCUSUNA bakın. Havuzlar artık `globalThis` üzerinde tutuluyor
 * ve sızıntı kapandı — düzeltmeden sonra tüm paket 24 saniyede
 * tamamlandı, öncesinde 591 saniye sürüp üç test zaman aşımına
 * uğruyordu.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    /*
     * DOSYALAR SIRALI KOŞAR.
     *
     * İş parçacığı sayısını 4'e indirmek yetmedi: asılmalar seyrekleşti
     * ama KAYBOLMADI ve aralıklı bir hata, olmayan bir hatadan daha
     * tehlikelidir — üç koşuda geçer, dördüncüde dağıtımı durdurur ve
     * kimse sebebini bilmez.
     *
     * Kalıcılık testleri aynı veritabanında şema kurup düşürüyor.
     * Şema düşürme, o şemada AÇIK BAĞLANTI kaldığı sürece bekler; iki
     * dosya aynı anda kurup düşürdüğünde birbirini bekletir. Bu, havuz
     * ayarıyla çözülecek bir yarış değil, paylaşılan kaynağın kendisidir.
     *
     * Bedeli ölçüldü: sıralı koşu birkaç saniye daha uzun sürüyor.
     * Aralıklı on altı dakikalık asılmanın yanında bu bir bedel değil.
     */
    fileParallelism: false,
  },
});
