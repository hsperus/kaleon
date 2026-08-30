-- 021 — Teklif zinciri ve fiyat koşulları.
--
-- ZİNCİRİN İLK HALKASI EKSİKTİ. Hem satışta hem satın almada zincir
-- siparişten başlıyordu:
--
--   Satışta: "kaç teklif verdik, kaçı siparişe döndü" sorusunun cevabı
--   hiçbir yerde yoktu. Dönüşüm oranı bir satış organizasyonunun en
--   temel ölçüsüdür ve ölçülemiyordu.
--
--   Satın almada: tek teklifle sipariş vermek bir karar değil bir
--   alışkanlıktır. En az iki teklif toplanmadan "neden bu tedarikçi"
--   sorusunun kayıtlı bir cevabı olmaz.
--
-- FİYAT DA BİR ALAN DEĞİL BİR HESAPTIR. Sipariş kalemine elle fiyat
-- yazmak, hesabı satışçının kafasına bırakmaktır — ve her satışçının
-- kafasındaki hesap farklıdır.

CREATE TABLE "price_conditions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "partner_id" TEXT,
    "item_code" TEXT,
    "partner_group" TEXT,
    "min_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "value" DECIMAL(18,4) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_conditions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "price_conditions_item_active_idx" ON "price_conditions"("item_code", "is_active");
CREATE INDEX "price_conditions_partner_active_idx" ON "price_conditions"("partner_id", "is_active");

ALTER TABLE "price_conditions"
  ADD CONSTRAINT "price_conditions_kind_valid"
    CHECK ("kind" IN ('fiyat', 'iskonto_yuzde', 'iskonto_tutar', 'ek_ucret')),
  -- NEGATİF FİYAT VE İSKONTO OLMAZ. Negatif iskonto bir zam olur ve
  -- adı yanlış olduğu için kimse fark etmez.
  ADD CONSTRAINT "price_conditions_value_nonneg" CHECK ("value" >= 0),
  ADD CONSTRAINT "price_conditions_date_order"
    CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

CREATE TABLE "sales_quotations" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "quoted_at" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rejection_reason" TEXT,
    "sales_order_no" TEXT,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sales_quotations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_quotations_document_no_key" ON "sales_quotations"("document_no");
CREATE INDEX "sales_quotations_partner_quoted_idx" ON "sales_quotations"("partner_id", "quoted_at");
CREATE INDEX "sales_quotations_status_idx" ON "sales_quotations"("status");

ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_partner_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- GEÇERLİLİK SÜRESİ TEKLİF TARİHİNDEN ÖNCE OLAMAZ.
ALTER TABLE "sales_quotations"
  ADD CONSTRAINT "sales_quotations_validity" CHECK ("valid_until" >= "quoted_at"),
  ADD CONSTRAINT "sales_quotations_status_valid"
    CHECK ("status" IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'ordered'));

CREATE TABLE "sales_quotation_lines" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat_rate" INTEGER NOT NULL DEFAULT 20,
    CONSTRAINT "sales_quotation_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_quotation_lines_quote_line_key"
  ON "sales_quotation_lines"("quotation_id", "line_no");

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_quote_fkey"
  FOREIGN KEY ("quotation_id") REFERENCES "sales_quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sales_quotation_lines"
  ADD CONSTRAINT "sales_quotation_lines_qty_positive" CHECK ("quantity" > 0);

CREATE TABLE "purchase_rfqs" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "requisition_no" TEXT,
    "requested_at" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "awarded_quote_id" UUID,
    "award_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_rfqs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_rfqs_document_no_key" ON "purchase_rfqs"("document_no");
CREATE INDEX "purchase_rfqs_status_idx" ON "purchase_rfqs"("status");

ALTER TABLE "purchase_rfqs"
  ADD CONSTRAINT "purchase_rfqs_status_valid"
    CHECK ("status" IN ('open', 'closed', 'awarded', 'cancelled'));

CREATE TABLE "supplier_quotes" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "partner_id" TEXT NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "lead_time_days" INTEGER,
    "valid_until" DATE,
    "note" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "supplier_quotes_pkey" PRIMARY KEY ("id")
);

-- AYNI TEDARİKÇİDEN TEK TEKLİF. İkinci teklif ayrı bir satır olarak
-- girilseydi, karşılaştırma tablosunda aynı firma iki kez görünür ve
-- "en ucuz" hesabı bozulurdu.
CREATE UNIQUE INDEX "supplier_quotes_rfq_partner_key" ON "supplier_quotes"("rfq_id", "partner_id");

ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_rfq_fkey"
  FOREIGN KEY ("rfq_id") REFERENCES "purchase_rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supplier_quotes"
  ADD CONSTRAINT "supplier_quotes_amount_positive" CHECK ("total_amount" > 0);
