-- 024 — Seri numarası izleme.
--
-- `items.serial_managed` alanı vardı ama arkasında hiçbir kayıt yoktu:
-- "bu makine kime satıldı", "garantisi ne zaman bitiyor", "hangi
-- partiden çıktı" sorularının cevabı sistemde YOKTU.
--
-- Parti izleme bu soruları cevaplayamaz: parti bir yığını izler, seri
-- tek bir nesneyi. Müşteri "benim aldığım cihaz" der ve parti numarası
-- onu göstermez.

CREATE TABLE "serial_numbers" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'stokta',
    "batch_id" TEXT,
    "produced_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "delivery_id" UUID,
    "partner_id" TEXT,
    "warranty_months" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "serial_numbers_pkey" PRIMARY KEY ("id")
);

-- SERİ NUMARASI MALZEME İÇİNDE TEKTİR. Tekrar kullanılabilseydi iki
-- farklı ürünün geçmişi tek kayıtta birleşir ve garanti hangi ürüne ait
-- anlaşılamazdı.
CREATE UNIQUE INDEX "serial_numbers_item_serial_key" ON "serial_numbers"("item_id", "serial");
CREATE INDEX "serial_numbers_serial_idx" ON "serial_numbers"("serial");
CREATE INDEX "serial_numbers_state_idx" ON "serial_numbers"("state");
CREATE INDEX "serial_numbers_partner_idx" ON "serial_numbers"("partner_id");

ALTER TABLE "serial_numbers"
  ADD CONSTRAINT "serial_numbers_state_valid"
    CHECK ("state" IN ('stokta', 'sevk_edildi', 'serviste', 'hurda'));

-- HURDAYA AYRILAN SERİ GERİ DÖNEMEZ — veritabanı seviyesinde.
CREATE OR REPLACE FUNCTION "serial_scrap_is_final"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" = 'hurda' AND NEW."state" <> 'hurda' THEN
    RAISE EXCEPTION 'Hurdaya ayrılmış seri yeniden kullanılamaz: % / %',
      OLD."item_id", OLD."serial";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "serial_scrap_is_final_trg"
  BEFORE UPDATE ON "serial_numbers"
  FOR EACH ROW EXECUTE FUNCTION "serial_scrap_is_final"();
