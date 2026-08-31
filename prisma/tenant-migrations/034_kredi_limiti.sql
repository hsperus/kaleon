-- 034 — Kredi limiti ve risk bloğu (SAP SD credit management karşılığı).
--
-- BİR İMALATÇI EN ÇOK TAHSİL EDEMEDİĞİ SATIŞTAN ZARAR EDER: malı
-- gitmiş, parası gelmemiş, üstüne KDV'si beyan edilmiştir. Sistemde
-- alacak yaşlandırma ve ihtar vardı — ikisi de OLAY OLDUKTAN SONRA
-- devreye giriyor. Kredi limiti, siparişi AÇILMADAN durdurur.
--
-- FATURADAN SONRA YAPILAN HER KONTROL GEÇ KALMIŞTIR.
--
-- ─────────────────────────────────────────────────────────────────
--
-- LİMİT NULL OLABİLİR VE BU "SINIRSIZ" DEMEK DEĞİLDİR.
--
-- NULL = "bu cari için limit henüz belirlenmemiş". Kontrol bunu
-- sıfır saymaz (her siparişi bloke ederdi) ve sonsuz da saymaz
-- (kontrolü anlamsız kılardı) — LİMİTSİZ olduğunu açıkça söyler ve
-- kararı insana bırakır. Sessiz bir varsayılan, iki yönde de yanlış
-- olurdu.

ALTER TABLE "partners" ADD COLUMN "credit_limit" DECIMAL(18,2);
ALTER TABLE "partners" ADD COLUMN "credit_currency" TEXT NOT NULL DEFAULT 'TRY';
-- Elle konan blok: limit dolmasa da bu cariye satış yapılmasın.
-- Genellikle hukuki takip ya da ticari anlaşmazlık sebebiyle.
ALTER TABLE "partners" ADD COLUMN "credit_blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "partners" ADD COLUMN "credit_block_reason" TEXT;

ALTER TABLE "partners" ADD CONSTRAINT "partners_credit_limit_positive"
  CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);

-- BLOK VARSA SEBEBİ DE VARDIR. Sebepsiz bir blok, aylar sonra kimsenin
-- kaldırmaya cesaret edemediği bir bloktur.
ALTER TABLE "partners" ADD CONSTRAINT "partners_credit_block_needs_reason"
  CHECK ("credit_blocked" = false OR "credit_block_reason" IS NOT NULL);

-- Limit değişikliği İZ BIRAKIR: kim, ne zaman, neden yükseltti.
-- `master_data_changes` tetikleyicisi zaten partners tablosunu
-- izliyor; bu kolonlar da kendiliğinden oraya düşer.

CREATE INDEX "partners_credit_blocked_idx" ON "partners"("credit_blocked")
  WHERE "credit_blocked" = true;
