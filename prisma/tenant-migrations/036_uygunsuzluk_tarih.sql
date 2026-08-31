-- 036 — Uygunsuzluk kapanışı açılıştan önce olamaz.
--
-- CANLI KOŞUMDA ÖLÇÜLDÜ: `ageDays: -2`.
--
-- Uygunsuzluk `now()` ile açılıyordu ama muayene geriye dönük
-- girilebiliyor: dün ölçülen bir sapma bugün sisteme giriliyor,
-- uygunsuzluk BUGÜN açılıyor ve dünkü tarihle kapatılınca yaşı
-- negatif çıkıyordu.
--
-- Kök neden uygulama tarafında düzeltildi (açılış artık muayene
-- tarihi). Bu kısıt ikinci savunma: başka bir yazma yolu açılırsa
-- ya da elle müdahale olursa, "kaç gün açık kaldı" ölçüsü sessizce
-- negatife düşmesin. Kalite performansı raporu bu sayıya dayanıyor.

ALTER TABLE "nonconformances" ADD CONSTRAINT "nonconformances_closed_after_opened"
  CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at");
