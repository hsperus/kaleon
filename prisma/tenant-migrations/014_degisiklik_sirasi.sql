-- 014 — Değişiklik belgesine monotonik sıra numarası.
--
-- ZAMAN DAMGASI SIRALAMA İÇİN YETMEZ. Aynı işlem içindeki iki değişiklik
-- `NOW()` ile AYNI damgayı alır (işlem başlangıç zamanı), ardışık iki
-- işlem de aynı milisaniyeye düşebilir. Böyle bir durumda "önce neydi,
-- sonra ne oldu" sorusunun cevabı sorgudan sorguya DEĞİŞİR — bir değişiklik
-- belgesinin verebileceği en kötü cevap budur.
--
-- BIGSERIAL yazma sırasını kesin olarak sabitler.
ALTER TABLE "master_data_changes" ADD COLUMN "seq" BIGSERIAL;
CREATE INDEX "master_data_changes_seq_idx" ON "master_data_changes"("seq" DESC);
