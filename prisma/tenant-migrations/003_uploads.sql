-- 003 — Yüklenen dosyaların paylaşılan deposu.
--
-- ÖNCEKİ HÂLİ BELLEKTEYDİ VE BOZUKTU.
-- Süreç belleğindeki bir depo, yüklemeyi alan sunucu ile soruyu alan
-- sunucunun aynı olmasını varsayar. Bu varsayım iki yerde kırılır:
--   - çok örnekli üretimde (yükleme A'ya, soru B'ye gider),
--   - geliştirmede modül yeniden yüklendiğinde (tarayıcı testinde bu
--     gerçekten yaşandı: yükleme başarılı, önizleme "dosya bulunamadı").
--
-- KALICI DEĞİL, SÜRELİ. Yüklenen dosya henüz KAELON'un verisi değildir;
-- kullanıcı önizlemeyi görür ve vazgeçebilir. `expires_at` geçen kayıtlar
-- okunmaz ve temizlenir — onaylanmamış müşteri verisini süresiz tutmak
-- KVKK açısından savunulamaz.

CREATE TABLE "file_uploads" (
  "id"         UUID NOT NULL,
  "user_id"    UUID NOT NULL,
  "filename"   TEXT NOT NULL,
  "content"    TEXT NOT NULL,
  "byte_size"  INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "file_uploads_pkey" PRIMARY KEY ("id")
);

-- Süresi geçenleri toplu silmek için.
CREATE INDEX "file_uploads_expires_at_idx" ON "file_uploads"("expires_at");
