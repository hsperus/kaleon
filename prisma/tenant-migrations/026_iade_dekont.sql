-- 026 — Satış iadesi ve dekontlar.
--
-- SATIŞ ZİNCİRİ TEK YÖNLÜYDÜ: teklif → sipariş → irsaliye → fatura.
-- Gerçek hayatta mal geri gelir, fiyat düzeltilir, eksik teslim
-- edilir. Bunların kaydı yoksa işletme iadeyi "faturayı iptal
-- ederek" yapar — oysa kesilmiş fatura iptal edilemez, iade edilir.
-- İptal ile iade denetimde AYNI ŞEY DEĞİLDİR.
--
-- ÜÇ AYRI BELGE, ÜÇ AYRI MUHASEBE:
--   iade            → mal geri gelir: stok girer, 610 borçlanır
--   alacak_dekontu  → mal gelmez, fiyat düşer: 611 borçlanır
--   borc_dekontu    → müşteriye ek yansıtma: 600 alacaklanır
--
-- 610/611 KULLANILIR, 600 TERS YAZILMAZ. Satış hesabını ters yazmak
-- ciroyu düşürür ve "bu yıl ne kadar sattık" sorusunun cevabını
-- bozar; iade ayrı bir hesapta durur ve iade oranı ölçülebilir olur.

CREATE TABLE "sales_credit_notes" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    -- iade | alacak_dekontu | borc_dekontu
    "kind" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    -- Hangi faturaya karşılık — iade her zaman bir faturaya bağlıdır.
    "invoice_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,

    "net_amount" DECIMAL(18,2) NOT NULL,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,

    -- Mal geri geldi mi: geldiyse stok hareketi de yazılır.
    "with_goods" BOOLEAN NOT NULL DEFAULT false,
    "location_id" UUID,

    "reason" TEXT NOT NULL,
    -- draft | issued | cancelled
    "status" TEXT NOT NULL DEFAULT 'issued',
    "ettn" TEXT,
    "einvoice_kind" TEXT,
    "einvoice_status" TEXT,
    "issued_by" UUID,
    "journal_document_no" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_credit_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_credit_notes_invoice_fkey" FOREIGN KEY ("invoice_id")
        REFERENCES "sales_invoices"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "sales_credit_notes_document_no_key"
    ON "sales_credit_notes"("document_no");
CREATE INDEX "sales_credit_notes_partner_idx" ON "sales_credit_notes"("partner_id");
CREATE INDEX "sales_credit_notes_invoice_idx" ON "sales_credit_notes"("invoice_id");

CREATE TABLE "sales_credit_note_lines" (
    "id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    -- Hangi fatura satırından iade edildi — aşırı iadeyi engeller.
    "invoice_line_no" INTEGER,
    "item_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'adet',
    "unit_price" DECIMAL(18,4) NOT NULL,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "vat_rate" INTEGER NOT NULL DEFAULT 20,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "movement_id" UUID,
    CONSTRAINT "sales_credit_note_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_credit_note_lines_note_fkey" FOREIGN KEY ("note_id")
        REFERENCES "sales_credit_notes"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "sales_credit_note_lines_note_line_key"
    ON "sales_credit_note_lines"("note_id", "line_no");

-- Kesilmiş dekont da fatura gibi DEĞİŞTİRİLEMEZ: mali sonuç doğuran
-- her belge kayıt altındadır ve düzeltmesi ters belgedir.
CREATE OR REPLACE FUNCTION "credit_note_immutable"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Kesilmiş dekont silinemez (%).', OLD."document_no";
    END IF;
    -- İptal ve e-belge alanları güncellenebilir; mali içerik değişemez.
    IF NEW."net_amount" IS DISTINCT FROM OLD."net_amount"
       OR NEW."vat_amount" IS DISTINCT FROM OLD."vat_amount"
       OR NEW."total_amount" IS DISTINCT FROM OLD."total_amount"
       OR NEW."partner_id" IS DISTINCT FROM OLD."partner_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind" THEN
        RAISE EXCEPTION 'Kesilmiş dekontun mali içeriği değiştirilemez (%).', OLD."document_no";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sales_credit_notes_immutable"
    BEFORE UPDATE OR DELETE ON "sales_credit_notes"
    FOR EACH ROW EXECUTE FUNCTION "credit_note_immutable"();

-- Belge numarası serisi: iade ve dekontlar ayrı seri kullanır.
-- Faturayla aynı seriyi paylaşsalardı fatura numaralarında delik
-- oluşur ve vergi dairesi bunu sorar.
