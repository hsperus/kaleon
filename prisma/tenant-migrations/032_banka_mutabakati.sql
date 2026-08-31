-- 032 — Banka mutabakatı ve borç ihtarı.
--
-- ÖLÇÜLEN BOŞLUK: entegrasyon katmanı `bank_statement` tipinde ham
-- belge KABUL EDİYORDU ama o belgeyi defterle eşleştiren tek satır kod
-- yoktu. Yani boru vardı, süreç yoktu. Bu "eksik" değil "yarım"dır ve
-- yarım olan, tam olmayandan daha tehlikelidir: sistem veriyi alıyor
-- görünür, kimse eşleşmediğini fark etmez.
--
-- MUTABAKAT YAPILMADAN HİÇBİR MALİ TABLO GÜVENİLİR DEĞİLDİR. Defterdeki
-- 102 bakiyesi ile bankadaki bakiye tutmuyorsa, üstüne kurulan nakit
-- akışı da kârlılık da tahmindir.
--
-- ─────────────────────────────────────────────────────────────────
--
-- EŞLEŞTİRME OTOMATİK KAPATMAZ.
--
-- Sistem aday önerir; kapatan insandır. Tutar ve tarih tutan iki ayrı
-- ödeme olabilir ve yanlış olanı kapatmak, cari hesabı sessizce bozar.
-- Bir mutabakat hatası aylar sonra, hiç kimsenin hatırlamadığı bir
-- farkta ortaya çıkar.
--
-- BİR EKSTRE SATIRI EN FAZLA BİR ÖDEMEYE BAĞLANIR. Ödemenin kendisi
-- zaten birden çok faturaya dağılıyor (`payment_allocations`); araya
-- ikinci bir çok-a-çok koymak, aynı tutarı iki yerden saydırırdı.

CREATE TABLE "bank_statements" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    -- Bankanın verdiği ekstre numarası. Aynı ekstrenin iki kez
    -- yüklenmesi en sık görülen içe aktarma hatasıdır.
    "statement_no" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "opening_balance" DECIMAL(18,2) NOT NULL,
    "closing_balance" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "imported_by" UUID,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bank_statements_period" CHECK ("to_date" >= "from_date"),
    CONSTRAINT "bank_statements_account_fk"
      FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE
);

-- MÜKERRER EKSTRE KORUMASI VERİTABANI SEVİYESİNDE. Uygulama kontrolü
-- TOCTOU yarışına açıktır: iki eşzamanlı yükleme de "yok" görür.
CREATE UNIQUE INDEX "bank_statements_unique"
  ON "bank_statements"("account_id", "statement_no");

CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    -- Bankanın valör tarihi; bizim kaydettiğimiz tarih değil.
    "value_date" DATE NOT NULL,
    -- İŞARETLİ TUTAR: pozitif giriş, negatif çıkış. İki ayrı sütun
    -- (borc/alacak) tutulsaydı her sorguda hangisinin dolu olduğunu
    -- kontrol etmek gerekirdi ve biri sıfır, diğeri boş olduğunda
    -- ayrım kaybolurdu.
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT NOT NULL,
    "counterparty" TEXT,
    "counterparty_iban" TEXT,
    "reference" TEXT,
    -- open | matched | ignored
    "status" TEXT NOT NULL DEFAULT 'open',
    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bank_statement_lines_status"
      CHECK ("status" IN ('open', 'matched', 'ignored')),
    -- SIFIR TUTARLI SATIR YOKTUR. Bankadan gelirse bir ayrıştırma
    -- hatasıdır ve sessizce "eşleşmemiş" listesinde birikirdi.
    CONSTRAINT "bank_statement_lines_amount" CHECK ("amount" <> 0),
    CONSTRAINT "bank_statement_lines_stmt_fk"
      FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "bank_statement_lines_unique"
  ON "bank_statement_lines"("statement_id", "line_no");
CREATE INDEX "bank_statement_lines_status_idx"
  ON "bank_statement_lines"("status", "value_date");

CREATE TABLE "reconciliation_matches" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    -- Eşleştirilen ödeme belgesi. Ödeme zaten faturalara dağılmış
    -- durumda; zincir buradan devam eder.
    "payment_id" UUID NOT NULL,
    "matched_by" UUID NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Otomatik öneri kabul edildiyse skoru; elle eşleştirmede null.
    "suggested_score" INTEGER,
    "note" TEXT,
    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reconciliation_matches_line_fk"
      FOREIGN KEY ("line_id") REFERENCES "bank_statement_lines"("id") ON DELETE CASCADE
);

-- BİR SATIR BİR KEZ EŞLEŞİR, BİR ÖDEME BİR KEZ EŞLEŞİR. İkisi de
-- benzersiz: aynı ödemeyi iki ekstre satırına bağlamak, aynı parayı
-- iki kez tahsil edilmiş göstermek demektir.
CREATE UNIQUE INDEX "reconciliation_matches_line" ON "reconciliation_matches"("line_id");
CREATE UNIQUE INDEX "reconciliation_matches_payment" ON "reconciliation_matches"("payment_id");

-- ── İHTAR (DUNNING) ──
--
-- Vadesi geçmiş alacağa kademeli hatırlatma. Kademe sayısı ve gün
-- eşikleri işletmeye göre değişir; koda gömülemez.

CREATE TABLE "dunning_levels" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    -- Bu kademeye girmek için gereken asgari gecikme günü.
    "min_overdue_days" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    -- Mektuba basılacak metin. Hukuki dil işletmenin tercihidir.
    "body" TEXT NOT NULL,
    -- Bu kademede gecikme faizi işletiliyor mu (yıllık %).
    "interest_rate" DECIMAL(6,3),
    CONSTRAINT "dunning_levels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dunning_levels_level" CHECK ("level" BETWEEN 1 AND 9),
    CONSTRAINT "dunning_levels_days" CHECK ("min_overdue_days" >= 0)
);

CREATE UNIQUE INDEX "dunning_levels_unique" ON "dunning_levels"("level");

CREATE TABLE "dunning_notices" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "issued_at" DATE NOT NULL,
    -- İhtarın kapsadığı toplam ve en eski gecikme.
    "total_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "oldest_overdue_days" INTEGER NOT NULL,
    -- Hangi faturalar için — belge numaraları.
    "invoice_nos" TEXT[] NOT NULL,
    "issued_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dunning_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dunning_notices_no" ON "dunning_notices"("document_no");
CREATE INDEX "dunning_notices_partner" ON "dunning_notices"("partner_id", "issued_at");
