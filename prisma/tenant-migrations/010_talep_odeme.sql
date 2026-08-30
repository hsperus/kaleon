-- 010 — Satın alma talebi ve ödeme.
--
-- ÖNCESİNDE ZİNCİRİN İKİ UCU EKSİKTİ. Ortada sipariş, mal kabul, fatura ve
-- üç yönlü mutabakat vardı; ama sipariş NEDEN verildiği (talep ve onayı) ve
-- fatura NASIL kapandığı (ödeme) hiçbir yerde yoktu.
--
-- Talebin olmaması pratikte şu demekti: siparişi veren kişi, kendi kararını
-- kendi onaylıyordu. Ödemenin olmaması ise "bu faturayı ödedik mi"
-- sorusunun cevabının sistemde bulunmaması demekti.

CREATE TABLE "purchase_requisitions" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requested_by" UUID NOT NULL,
    "department" TEXT,
    "justification" TEXT,
    "estimated_total" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "rejected_by" UUID,
    "rejection_reason" TEXT,
    "purchase_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_requisitions_document_no_key" ON "purchase_requisitions"("document_no");
CREATE INDEX "purchase_requisitions_status_idx" ON "purchase_requisitions"("status");
CREATE INDEX "purchase_requisitions_requested_by_idx" ON "purchase_requisitions"("requested_by");

-- TALEP EDEN ONAYLAYAMAZ — veritabanı seviyesinde.
--
-- Uygulama kontrolü yeterli değil: bu, şirketin en klasik suistimaline
-- karşı tek yapısal savunmadır ve ileride yazılacak herhangi bir kod
-- yolunun onu atlayabilmesi kabul edilemez.
ALTER TABLE "purchase_requisitions"
  ADD CONSTRAINT "purchase_requisitions_self_approval"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by");

CREATE TABLE "purchase_requisition_lines" (
    "id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "estimated_price" DECIMAL(18,4),
    "needed_by" DATE NOT NULL,
    CONSTRAINT "purchase_requisition_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_requisition_lines_req_line_key"
  ON "purchase_requisition_lines"("requisition_id", "line_no");

ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_req_fkey"
  FOREIGN KEY ("requisition_id") REFERENCES "purchase_requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_requisition_lines"
  ADD CONSTRAINT "purchase_requisition_lines_quantity_positive" CHECK ("quantity" > 0);

CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "method" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "bank_account_id" TEXT,
    "reference" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payments_document_no_key" ON "payments"("document_no");
CREATE INDEX "payments_partner_id_paid_at_idx" ON "payments"("partner_id", "paid_at");
CREATE INDEX "payments_direction_idx" ON "payments"("direction");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_rate_positive" CHECK ("exchange_rate" > 0),
  ADD CONSTRAINT "payments_direction_valid" CHECK ("direction" IN ('outgoing', 'incoming'));

CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_allocations_payment_invoice_key"
  ON "payment_allocations"("payment_id", "invoice_no");
CREATE INDEX "payment_allocations_invoice_no_idx" ON "payment_allocations"("invoice_no");

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amount" > 0);
