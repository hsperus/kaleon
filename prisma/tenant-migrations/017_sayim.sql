-- 017 — Stok sayımı.
--
-- ÖNCESİNDE SAYIM YOKTU. Stok bakiyesi yalnızca hareketlerden hesaplanıyordu;
-- yani sistem kendi kayıtlarına bakıyor, gerçeğe hiç bakmıyordu. Oysa fire,
-- kırılma, yanlış yerleştirme ve kayıt hatası her depoda vardır ve bunların
-- tek bulunma yolu sayımdır.
--
-- Sayım olmadan "stok değerleme" iddiası da yarımdır: değerlemenin
-- doğruluğu, sayılan miktarın doğruluğu kadardır.

CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "count_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "counted_by" UUID,
    "posted_at" TIMESTAMP(3),
    "posted_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_counts_document_no_key" ON "stock_counts"("document_no");
CREATE INDEX "stock_counts_status_idx" ON "stock_counts"("status");
CREATE INDEX "stock_counts_location_date_idx" ON "stock_counts"("location_id", "count_date");

ALTER TABLE "stock_counts"
  ADD CONSTRAINT "stock_counts_status_valid"
    CHECK ("status" IN ('open', 'counted', 'posted', 'cancelled'));

CREATE TABLE "stock_count_lines" (
    "id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "system_qty" DECIMAL(18,4) NOT NULL,
    "counted_qty" DECIMAL(18,4),
    "unit_cost" DECIMAL(18,4),
    "counted_at" TIMESTAMP(3),
    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_count_lines_count_line_key" ON "stock_count_lines"("count_id", "line_no");
CREATE INDEX "stock_count_lines_item_id_idx" ON "stock_count_lines"("item_id");

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fkey"
  FOREIGN KEY ("count_id") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SAYILAN MİKTAR NEGATİF OLAMAZ. Fiziksel bir sayımda eksi adet yoktur;
-- eksi yazılması bir giriş hatasıdır ve stok düzeltmesine dönüşmemelidir.
ALTER TABLE "stock_count_lines"
  ADD CONSTRAINT "stock_count_lines_counted_nonneg"
    CHECK ("counted_qty" IS NULL OR "counted_qty" >= 0);

-- KAYDEDİLMİŞ SAYIM DEĞİŞTİRİLEMEZ.
--
-- Değiştirilebilseydi, stok düzeltmesi yapıldıktan sonra sayım kağıdı
-- düzeltilir ve fark izi kaybolurdu — sayımın denetim değeri tam olarak
-- o izdir.
CREATE OR REPLACE FUNCTION "stock_counts_immutable_when_posted"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'posted' THEN
      RAISE EXCEPTION 'Kaydedilmiş sayım silinemez: %', OLD."document_no";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'posted' THEN
    RAISE EXCEPTION 'Kaydedilmiş sayım değiştirilemez: %', OLD."document_no";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_counts_immutable_trg"
  BEFORE UPDATE OR DELETE ON "stock_counts"
  FOR EACH ROW EXECUTE FUNCTION "stock_counts_immutable_when_posted"();

CREATE OR REPLACE FUNCTION "stock_count_lines_immutable_when_posted"()
RETURNS TRIGGER AS $$
DECLARE
  st TEXT;
  doc TEXT;
BEGIN
  SELECT "status", "document_no" INTO st, doc
    FROM "stock_counts" WHERE "id" = COALESCE(NEW."count_id", OLD."count_id");

  IF st IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF st = 'posted' THEN
    RAISE EXCEPTION 'Kaydedilmiş sayımın satırları değiştirilemez: %', doc;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_count_lines_immutable_trg"
  BEFORE UPDATE OR DELETE ON "stock_count_lines"
  FOR EACH ROW EXECUTE FUNCTION "stock_count_lines_immutable_when_posted"();
