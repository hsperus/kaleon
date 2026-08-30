-- 006 — Satış zinciri: sipariş → sevkiyat → fatura, ve belge numaralandırma.
--
-- ÖNCESİNDE ZİNCİRİN ORTASI YOKTU. Sipariş vardı, gecikme cezası
-- hesaplanıyordu, ama malın ne zaman çıktığını ve ne kadarının
-- faturalandığını tutan hiçbir kayıt yoktu. "Ne kadar sevk ettik",
-- "ne kadarı faturalandı", "bu ay ne kestik" sorularının cevabı
-- veritabanında MEVCUT DEĞİLDİ.
--
-- Sipariş kaleminde fiyat da yoktu: sipariş bir taahhüt kaydıydı ama
-- tutarı bilinmiyordu. Ciro, kârlılık ve tahsilat bunun üzerine kurulur.
--
-- MEVCUT SATIRLAR BOZULMAZ: eklenen sütunlar varsayılanlıdır. Fiyatı
-- bilinmeyen eski siparişler 0 fiyatla durur ve raporda "fiyat girilmemiş"
-- olarak ayrışır — uydurma bir fiyatla doldurulmaz.

-- ── Sipariş: aşırı sevkiyat toleransı ve iptal ──
ALTER TABLE "sales_orders"
  ADD COLUMN "over_delivery_tolerance" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

-- ── Sipariş kalemi: fiyat ve ilerleme ──
ALTER TABLE "sales_order_lines"
  ADD COLUMN "uom" TEXT NOT NULL DEFAULT 'adet',
  ADD COLUMN "unit_price" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "vat_rate" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "delivered_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "invoiced_qty" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- SEVK EDİLEN MİKTAR NEGATİF OLAMAZ. İptal sırasında yanlış bir çıkarma,
-- eksi bakiye bırakıp sonraki her hesabı bozardı.
ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT "sales_order_lines_delivered_nonneg" CHECK ("delivered_qty" >= 0),
  ADD CONSTRAINT "sales_order_lines_invoiced_nonneg" CHECK ("invoiced_qty" >= 0);

-- ── Belge numarası sayacı ──
CREATE TABLE "document_number_ranges" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_number_ranges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_number_ranges_kind_series_year_key"
  ON "document_number_ranges"("kind", "series", "year");

-- SAYAÇ GERİ ALINAMAZ. Numara verildikten sonra geri sarmak, aynı numaranın
-- iki belgeye çıkması demektir; mevzuat karşısında bu bir sahtecilik izidir.
CREATE OR REPLACE FUNCTION "document_number_ranges_no_rewind"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."last_number" < OLD."last_number" THEN
    RAISE EXCEPTION 'Belge numarası sayacı geri alınamaz: % serisi %. sıradan %. sıraya döndürülemez.',
      OLD."series", OLD."last_number", NEW."last_number";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "document_number_ranges_no_rewind_trg"
  BEFORE UPDATE ON "document_number_ranges"
  FOR EACH ROW EXECUTE FUNCTION "document_number_ranges_no_rewind"();

-- ── Sevk irsaliyesi ──
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "location_id" TEXT NOT NULL,
    "shipped_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "carrier_name" TEXT,
    "plate_no" TEXT,
    "ettn" TEXT,
    "edespatch_status" TEXT,
    "posted_at" TIMESTAMP(3),
    "posted_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deliveries_document_no_key" ON "deliveries"("document_no");
CREATE INDEX "deliveries_sales_order_id_idx" ON "deliveries"("sales_order_id");
CREATE INDEX "deliveries_partner_id_shipped_at_idx" ON "deliveries"("partner_id", "shipped_at");
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sales_order_id_fkey"
  FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "delivery_lines" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "order_line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "batch_id" TEXT,
    "movement_id" UUID,
    CONSTRAINT "delivery_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_lines_delivery_id_line_no_key" ON "delivery_lines"("delivery_id", "line_no");
CREATE INDEX "delivery_lines_item_id_idx" ON "delivery_lines"("item_id");

ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_delivery_id_fkey"
  FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_lines"
  ADD CONSTRAINT "delivery_lines_quantity_positive" CHECK ("quantity" > 0);

-- ── Satış faturası ──
CREATE TABLE "sales_invoices" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "sales_order_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "due_date" DATE,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "discount_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "einvoice_kind" TEXT,
    "ettn" TEXT,
    "einvoice_status" TEXT,
    "issued_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_invoices_document_no_key" ON "sales_invoices"("document_no");
CREATE INDEX "sales_invoices_partner_id_issued_at_idx" ON "sales_invoices"("partner_id", "issued_at");
CREATE INDEX "sales_invoices_sales_order_id_idx" ON "sales_invoices"("sales_order_id");
CREATE INDEX "sales_invoices_status_idx" ON "sales_invoices"("status");

-- KUR SIFIR OLAMAZ. Sıfır kur, yabancı para faturanın TL karşılığını sıfır
-- yapar ve KDV matrahını yok eder.
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_rate_positive" CHECK ("exchange_rate" > 0);

CREATE TABLE "sales_invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "delivery_id" UUID,
    "delivery_line_no" INTEGER,
    "order_line_no" INTEGER,
    "item_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat_rate" INTEGER NOT NULL,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_invoice_lines_invoice_id_line_no_key" ON "sales_invoice_lines"("invoice_id", "line_no");
CREATE INDEX "sales_invoice_lines_delivery_id_idx" ON "sales_invoice_lines"("delivery_id");

ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- KESİLMİŞ FATURA SİLİNEMEZ VE DEĞİŞTİRİLEMEZ.
--
-- Denetim kaydındaki tetikleyicinin aynısı: taslak düzenlenebilir, ama
-- `issued` durumuna geçmiş bir fatura mevzuat karşısında bir belgedir.
-- Yanlışsa iptal edilir (durumu 'cancelled' olur) ve yerine yenisi kesilir;
-- içeriği geriye dönük değiştirilemez.
CREATE OR REPLACE FUNCTION "sales_invoices_immutable_when_issued"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'Kesilmiş fatura silinemez: %. İptal edilmelidir.', OLD."document_no";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'issued' THEN
    -- Tek izinli değişiklik iptaldir; tutar ve kalemler dokunulmazdır.
    IF NEW."status" <> 'cancelled'
       OR NEW."total_amount" <> OLD."total_amount"
       OR NEW."net_amount" <> OLD."net_amount"
       OR NEW."vat_amount" <> OLD."vat_amount"
       OR NEW."document_no" <> OLD."document_no"
       OR NEW."partner_id" <> OLD."partner_id"
       OR NEW."issued_at" <> OLD."issued_at" THEN
      RAISE EXCEPTION 'Kesilmiş fatura değiştirilemez: %. Yalnızca iptal edilebilir.', OLD."document_no";
    END IF;
  END IF;

  IF OLD."status" = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş fatura değiştirilemez: %', OLD."document_no";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sales_invoices_immutable_trg"
  BEFORE UPDATE OR DELETE ON "sales_invoices"
  FOR EACH ROW EXECUTE FUNCTION "sales_invoices_immutable_when_issued"();

-- Kesilmiş faturanın KALEMLERİ de dokunulmazdır; başlığı korumak tek
-- başına yetmez, kalem tutarı değişirse belge yine tahrif edilmiş olur.
CREATE OR REPLACE FUNCTION "sales_invoice_lines_immutable_when_issued"()
RETURNS TRIGGER AS $$
DECLARE
  inv_status TEXT;
  inv_no TEXT;
BEGIN
  SELECT "status", "document_no" INTO inv_status, inv_no
    FROM "sales_invoices"
   WHERE "id" = COALESCE(NEW."invoice_id", OLD."invoice_id");

  -- Fatura başlığı cascade ile silinirken kalem satırı da silinir; o an
  -- başlık artık okunamaz ve engellenecek bir şey de yoktur.
  IF inv_status IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF inv_status <> 'draft' THEN
    RAISE EXCEPTION 'Kesilmiş faturanın kalemleri değiştirilemez: %', inv_no;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sales_invoice_lines_immutable_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "sales_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "sales_invoice_lines_immutable_when_issued"();
