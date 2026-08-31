-- 040 — Satın alma siparişinde termin tarihi.
--
-- BU MİGRATION BİR HATANIN DÜZELTMESİ.
--
-- Termin alanı önce 034'ün SONUNA eklenmişti — ama 034 o sırada
-- ÜRETİME UYGULANMIŞTI. Checksum koruması bunu bir sonraki dağıtımda
-- yakaladı ve `uls` kiracısı güncellenemedi:
--
--   "34_kredi_limiti migration'ı uygulandıktan SONRA değiştirilmiş
--    (defter: 6f4f0b4a…, dosya: 9f96c9ba…)"
--
-- Koruma tam olarak bunun için var: uygulanmış bir migration'ı
-- düzenlemek, aynı sürüm numarasının farklı ortamlarda farklı şema
-- anlamına gelmesi demektir. 034 uygulandığı hâline geri alındı ve
-- alan buraya taşındı.
--
-- ─────────────────────────────────────────────────────────────────
--
-- IF NOT EXISTS KULLANILIYOR, KASITLI.
--
-- Geliştirme ortamlarında bu kolon zaten var (034'ün düzenlenmiş
-- hâliyle geldi). Koşulsuz bir ALTER orada patlardı ve düzeltme
-- migration'ı, düzeltmeye çalıştığı sorunun aynısını üretirdi.
--
-- ATP'nin ikinci ayağı: "yolda ne var, ne zaman gelecek". Tarihsiz
-- bir bekleyen mal teslim taahhüdüne giremez — "yolda 500 adet var"
-- cümlesi, ne zaman geleceği bilinmiyorsa müşteriye söylenemez.
-- NULL kalabilir ve kalması anlamlıdır: tedarikçi termin vermemişse
-- uydurmak yerine boş bırakılır; ATP tarihsiz satırları hesaba
-- KATMAZ.

ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "promised_date" DATE;

CREATE INDEX IF NOT EXISTS "purchase_order_lines_promised_idx"
  ON "purchase_order_lines"("item_id", "promised_date");
