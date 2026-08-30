-- 016 — Yevmiye defteri ve muhasebe kaydı.
--
-- ÖNCESİNDE MUHASEBE HİÇ YOKTU. Fatura kesiliyor, ödeme yapılıyor, stok
-- hareket ediyordu — ama hiçbiri bir hesaba işlemiyordu. Yani sistem
-- "ne sattık" sorusuna cevap verebiliyor, "kâr ettik mi" sorusuna
-- veremiyordu; mizan, bilanço ve gelir tablosu çıkarılamıyordu.
--
-- Bir ERP'yi operasyon aracından ayıran şey budur: her belge muhasebeye
-- düşer ve iki gerçek (operasyon ve mali tablo) tek kaynaktan çıkar.
--
-- ÇİFT TARAFLI KAYIT VERİTABANINDA KORUNUR. Uygulamada kontrol edilmesi
-- yeterli değildir: bir betik, bir düzeltme sorgusu ya da ileride
-- yazılacak bir kod yolu denksiz fiş yazarsa mizan bir daha tutmaz ve
-- hangi fişten bozulduğunu bulmak günler alır.

CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "entry_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "total_debit" DECIMAL(18,2) NOT NULL,
    "total_credit" DECIMAL(18,2) NOT NULL,
    "reversed_by" UUID,
    "reversal_of" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "journal_entries_document_no_key" ON "journal_entries"("document_no");
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries"("entry_date");
CREATE INDEX "journal_entries_status_idx" ON "journal_entries"("status");

-- AYNI BELGEDEN İKİ FİŞ ÇIKAMAZ. Çıksaydı bir fatura iki kez
-- muhasebeleşir, ciro iki katına çıkar ve kimse fark etmezdi.
-- NULL source_id'ler (elle fiş) bu kısıttan etkilenmez: SQL'de NULL
-- hiçbir şeye eşit değildir, bu yüzden elle fişler serbestçe açılabilir.
CREATE UNIQUE INDEX "journal_entries_source_key"
  ON "journal_entries"("source_kind", "source_id");

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_status_valid"
    CHECK ("status" IN ('draft', 'posted', 'reversed')),
  -- Fişin kendi toplamları da denk olmalıdır.
  ADD CONSTRAINT "journal_entries_balanced" CHECK ("total_debit" = "total_credit"),
  ADD CONSTRAINT "journal_entries_totals_nonneg"
    CHECK ("total_debit" >= 0 AND "total_credit" >= 0);

CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_code" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "partner_id" TEXT,
    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "journal_lines_entry_line_key" ON "journal_lines"("entry_id", "line_no");
CREATE INDEX "journal_lines_account_entry_idx" ON "journal_lines"("account_code", "entry_id");
CREATE INDEX "journal_lines_partner_id_idx" ON "journal_lines"("partner_id");

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BİR SATIR TEK YÖNLÜDÜR. Hem borç hem alacak taşıyan bir satır, fişin
-- okunması için hesap makinesi gerektirir.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_nonneg" CHECK ("debit" >= 0 AND "credit" >= 0),
  ADD CONSTRAINT "journal_lines_one_side"
    CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));

-- ─────────────────────────────────────────────────────────────
-- FİŞ DENKLİĞİ: satır toplamları başlıkla ve birbiriyle uyuşmalı.
--
-- Satırlar yazıldıktan SONRA kontrol edilir (constraint trigger,
-- işlem sonunda). Satır satır kontrol edilseydi, ilk satır yazıldığı
-- anda fiş zaten denksiz olurdu ve hiçbir fiş kaydedilemezdi.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "journal_entry_must_balance"()
RETURNS TRIGGER AS $$
DECLARE
  d NUMERIC;
  c NUMERIC;
  hdr_d NUMERIC;
  hdr_c NUMERIC;
  doc TEXT;
  eid UUID;
BEGIN
  eid := COALESCE(NEW."entry_id", OLD."entry_id");

  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO d, c FROM "journal_lines" WHERE "entry_id" = eid;

  SELECT "total_debit", "total_credit", "document_no"
    INTO hdr_d, hdr_c, doc FROM "journal_entries" WHERE "id" = eid;

  -- Başlık cascade ile silinmişse kontrol edilecek bir şey kalmamıştır.
  IF doc IS NULL THEN
    RETURN NULL;
  END IF;

  IF d <> c THEN
    RAISE EXCEPTION 'Yevmiye fişi denk değil: % — borç %, alacak %.', doc, d, c;
  END IF;

  IF d <> hdr_d OR c <> hdr_c THEN
    RAISE EXCEPTION
      'Fiş başlığı satırlarla uyuşmuyor: % — başlık %/%, satırlar %/%.',
      doc, hdr_d, hdr_c, d, c;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "journal_lines_balance_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "journal_entry_must_balance"();

-- KESİLEN FİŞ DEĞİŞTİRİLEMEZ VE SİLİNEMEZ.
--
-- Yanlışsa TERS KAYIT atılır. Değiştirilebilseydi, geçmiş bir dönemin
-- mizanı bugün başka çıkar ve verilmiş beyanname dayanaksız kalırdı.
-- İzin verilen tek değişiklik, fişin ters kayıtla işaretlenmesidir.
CREATE OR REPLACE FUNCTION "journal_entries_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'Kesilmiş yevmiye fişi silinemez: %. Ters kayıt atılmalıdır.',
        OLD."document_no";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'posted' THEN
    IF NEW."total_debit" <> OLD."total_debit"
       OR NEW."total_credit" <> OLD."total_credit"
       OR NEW."entry_date" <> OLD."entry_date"
       OR NEW."document_no" <> OLD."document_no"
       OR (NEW."status" <> 'posted' AND NEW."status" <> 'reversed') THEN
      RAISE EXCEPTION 'Kesilmiş yevmiye fişi değiştirilemez: %', OLD."document_no";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_entries_immutable_trg"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "journal_entries_immutable"();

-- Kesilmiş fişin SATIRLARI da dokunulmazdır.
CREATE OR REPLACE FUNCTION "journal_lines_immutable"()
RETURNS TRIGGER AS $$
DECLARE
  st TEXT;
  doc TEXT;
BEGIN
  SELECT "status", "document_no" INTO st, doc
    FROM "journal_entries" WHERE "id" = COALESCE(NEW."entry_id", OLD."entry_id");

  IF st IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Ekleme, fiş henüz kesilirken olur; sonraki her dokunuş yasaktır.
  IF TG_OP <> 'INSERT' AND st <> 'draft' THEN
    RAISE EXCEPTION 'Kesilmiş fişin satırları değiştirilemez: %', doc;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_lines_immutable_trg"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "journal_lines_immutable"();
