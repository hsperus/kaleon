-- 020 — e-İrsaliye taşıma alanları.
--
-- 1 TEMMUZ 2026'DAN İTİBAREN ZORUNLU. e-Fatura kayıtlı ve cirosu 10
-- milyon TL üstü mükellef, sevk irsaliyesini kâğıt düzenleyemez.
--
-- İrsaliyede asıl bilgi tutar değil TAŞIMADIR: malın hangi araçla,
-- kimin sürücülüğünde ve NE ZAMAN yola çıktığı. Plaka ve taşıyıcı
-- alanları vardı; sürücü ve fiili sevk anı yoktu. Sürücü TC kimlik
-- numarası yol denetiminde sorulur; fiili sevk anı ise belgenin
-- geçerliliğini belirler — sonradan girilen bir saat, denetimde
-- belgesiz mal demektir.

ALTER TABLE "deliveries"
  ADD COLUMN "driver_name" TEXT,
  ADD COLUMN "driver_tckn" TEXT,
  ADD COLUMN "actual_despatch_at" TIMESTAMP(3);

-- SÜRÜCÜ TC KİMLİK NUMARASI 11 HANEDİR. Biçimi burada tutmak,
-- entegratörden dönen anlaşılmaz bir reddi önler.
ALTER TABLE "deliveries"
  ADD CONSTRAINT "deliveries_driver_tckn_format"
    CHECK ("driver_tckn" IS NULL OR "driver_tckn" ~ '^[0-9]{11}$');
