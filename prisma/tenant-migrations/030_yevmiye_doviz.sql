-- 030 — Yevmiye satırı döviz taşır.
--
-- DEFTER BUGÜNE KADAR YALNIZCA TL BİLİYORDU. Fatura dövizliydi
-- (`invoices.currency`), sipariş dövizliydi, hatta stok hareketinde
-- `source_currency` vardı — ama fişe geçince hepsi TL'ye dönüşüyor ve
-- özgün para birimi kayboluyordu. Bunun üç sonucu vardı:
--
--   1. "Bu müşteri bana kaç EUR borçlu?" sorusu DEFTERDEN cevaplanamaz.
--      Cevap ancak faturaları tek tek toplayarak bulunur ve o toplam
--      ödemelerle kapanmadığı için yanlış çıkar.
--
--   2. DÖNEM SONU KUR DEĞERLEMESİ YAPILAMAZ. VUK 280 dövizli
--      alacak/borçların dönem sonunda değerlenmesini ister. Değerleme
--      için "kaç döviz açık" bilgisi gerekir; TL tutar bunu vermez.
--
--   3. Dövizli cari ekstresi çıkarılamaz. İhracatçı müşterisiyle EUR
--      üzerinden mutabakat yapar; TL ekstre işe yaramaz.
--
-- ÇÖZÜM SAP'NİN ÇÖZÜMÜYLE AYNI: her satır İKİ para biriminde tutulur —
-- işlem para birimi ve defter para birimi (TL). ACDOCA da böyle
-- çalışır. Yer israfı gibi görünür ama alternatifi her sorguda özel
-- durum yazmaktır.
--
-- TL SATIRLAR DA DOLDURULUR. `currency='TRY'`, `fx_debit=debit`,
-- `fx_rate=1`. Böylece "dövizli mi" diye ayıran bir dal YOKTUR: tek
-- bir sorgu her satırda çalışır. Boş bırakılsaydı her toplamda
-- COALESCE gerekirdi ve biri mutlaka unutulurdu.

ALTER TABLE "journal_lines"
    ADD COLUMN "currency"  TEXT           NOT NULL DEFAULT 'TRY',
    -- İşlem para birimindeki tutar. Borç/alacak ayrımı TL tarafıyla
    -- birebir aynı — aynı satır iki yerde birden borç olamaz.
    ADD COLUMN "fx_debit"  DECIMAL(18, 2) NOT NULL DEFAULT 0,
    ADD COLUMN "fx_credit" DECIMAL(18, 2) NOT NULL DEFAULT 0,
    -- Kaydın atıldığı andaki kur. Sonradan değişmez: dönem sonu
    -- değerlemesi bu kurla bugünkü kuru KARŞILAŞTIRIR. Kur alanı
    -- güncellenseydi fark hesaplanamaz, sadece kaybolurdu.
    ADD COLUMN "fx_rate"   DECIMAL(18, 6) NOT NULL DEFAULT 1;

-- Mevcut satırlar TL'dir; döviz tarafı TL tutarın aynısıdır.
--
-- TETİKLEYİCİ BURADA BİLEREK DURDURULUYOR. `journal_lines` üzerinde
-- "kesilmiş fişin satırları değiştirilemez" kuralı var ve doğru
-- yerde duruyor: uygulama kodu geçmiş bir fişin tutarını
-- değiştiremesin diye kondu.
--
-- Ama bu bir TUTAR DEĞİŞİKLİĞİ DEĞİL, yeni bir sütunun ilk
-- doldurulmasıdır. Borç ve alacak rakamlarına dokunulmuyor; yalnızca
-- "bu satır TL'dir ve kuru 1'dir" bilgisi yazılıyor.
--
-- Doldurulmasaydı geçmiş satırlar `fx_debit = 0` kalırdı ve
-- "TL satırda döviz tarafı TL tutarın aynısıdır" değişmezi baştan
-- bozuk olurdu — her toplamda COALESCE gerektiren, birinin mutlaka
-- unutacağı bir durum.
--
-- Durdurma bu göçün İŞLEMİ İÇİNDE geçerlidir ve göç kayıt defterine
-- yazılır: ne zaman, hangi sürümde, hangi içerikle koştuğu bellidir.
ALTER TABLE "journal_lines" DISABLE TRIGGER USER;

UPDATE "journal_lines"
   SET "fx_debit" = "debit",
       "fx_credit" = "credit"
 WHERE "fx_debit" = 0 AND "fx_credit" = 0;

ALTER TABLE "journal_lines" ENABLE TRIGGER USER;

-- KUR SIFIR OLAMAZ. Sıfır kur, dövizli tutarı sessizce sıfır TL'ye
-- çevirir — bir ERP'nin yapabileceği en pahalı hata. Negatif kur ise
-- anlamsızdır.
ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_fx_rate_positive" CHECK ("fx_rate" > 0);

-- Bir satır aynı anda hem döviz borcu hem döviz alacağı olamaz —
-- TL tarafındaki kuralın aynısı.
ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_fx_side" CHECK ("fx_debit" = 0 OR "fx_credit" = 0);

-- TL SATIRDA KUR 1'DİR. Aksi hâlde "TRY ama kur 32" gibi bir satır
-- yazılabilir ve hangi rakamın doğru olduğu belirsizleşir.
ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_try_rate_one"
    CHECK ("currency" <> 'TRY' OR "fx_rate" = 1);

-- Dönem sonu değerlemesi "hangi hesapta, hangi cariden, hangi
-- para biriminde ne kadar açık var" diye sorar.
CREATE INDEX "journal_lines_currency_idx"
    ON "journal_lines"("currency", "account_code")
    WHERE "currency" <> 'TRY';

-- ─────────────────────────────────────────────────────────────────
-- Değerleme koşusu — hangi dönem, hangi kurla, hangi fişi doğurdu.
--
-- NEDEN AYRI TABLO: değerleme fişi sıradan bir fiş gibi görünür ama
-- geri alınması gerektiğinde (kur yanlış girilmiş, dönem yeniden
-- açılmış) hangi fişin hangi değerlemeye ait olduğu bilinmelidir.
-- `journal_entries.source_kind='fx_revaluation'` tek başına yetmez:
-- aynı dönemde iki kez değerleme yapılırsa hangisi geçerli, ondan
-- anlaşılmaz.
CREATE TABLE "fx_revaluations" (
    "id"          UUID NOT NULL,
    -- Değerleme tarihi — dönemin son günü.
    "as_of"       DATE NOT NULL,
    -- Oluşan yevmiye fişi. Fiş ters kaydedilirse burası da düşer.
    "entry_id"    UUID,
    -- Toplam kur farkı; pozitif kâr, negatif zarar.
    "difference"  DECIMAL(18, 2) NOT NULL,
    -- Kaç satır değerlendi.
    "line_count"  INTEGER NOT NULL,
    -- Kullanılan kurlar — denetimde "hangi kurla değerlediniz"
    -- sorusunun cevabı. Sonradan TCMB'den yeniden çekilemez, çünkü
    -- hangi tarihin kuru kullanıldığı da burada.
    "rates"       JSONB NOT NULL,
    "created_by"  UUID NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fx_revaluations_pkey" PRIMARY KEY ("id")
);

-- AYNI TARİHE İKİ GEÇERLİ DEĞERLEME OLAMAZ. İkincisi kur farkını
-- ikinci kez yazar ve kambiyo kârı iki katına çıkar.
CREATE UNIQUE INDEX "fx_revaluations_as_of_key"
    ON "fx_revaluations"("as_of")
    WHERE "entry_id" IS NOT NULL;
