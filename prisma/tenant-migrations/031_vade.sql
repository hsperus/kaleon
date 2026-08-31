-- 031 — Vade: ödeme koşusu ve nakit akışının eksik ön şartı.
--
-- ÖLÇÜLEN BOŞLUK: tedarikçi faturasında VADE TARİHİ YOKTU. `invoices`
-- tablosunda yalnızca `issued_at` vardı. Bunun sonucu şuydu: "kime ne
-- zaman ödeyeceğiz" sorusunun sistemde bir cevabı yoktu. Ödeme koşusu
-- yazılamıyordu, nakit akış projeksiyonu yapılamıyordu, gecikmiş bir
-- borç ile bir ay sonra ödenecek bir borç aynı yerde duruyordu.
--
-- Satış tarafında `sales_invoices.due_date` vardı — yani alacağın
-- vadesi biliniyordu ama borcun vadesi bilinmiyordu. Bu asimetri
-- nakit akışını tek taraflı ve dolayısıyla yanıltıcı yapardı.
--
-- ─────────────────────────────────────────────────────────────────
--
-- GEÇMİŞ FATURALAR DOLDURULMUYOR.
--
-- Cari vadesinden geriye dönük bir vade hesaplayıp yazmak kolaydı ve
-- yanlış olurdu: o faturaların gerçek vadesini bilmiyoruz. Uydurulan
-- tarih, ödeme koşusuna "bugün ödenmeli" ya da "daha var" diye girer
-- ve kimse bunun bir tahmin olduğunu bir daha hatırlamaz.
--
-- Vadesi bilinmeyen fatura NULL kalır ve tool'lar bunu ayrı bir
-- başlık altında, tutarıyla birlikte açıkça bildirir. Bilinmeyen,
-- sıfır değildir.

-- Carinin varsayılan vadesi — yeni faturanın vadesi buradan türetilir.
-- NULL: bu cariyle vade konuşulmamış; fatura girilirken sorulur.
ALTER TABLE "partners" ADD COLUMN "payment_terms_days" INTEGER;

ALTER TABLE "partners" ADD CONSTRAINT "partners_terms_range"
  CHECK ("payment_terms_days" IS NULL
         OR ("payment_terms_days" >= 0 AND "payment_terms_days" <= 365));

-- Tedarikçi faturasının vadesi. NULL: bilinmiyor, tahmin edilmiyor.
ALTER TABLE "invoices" ADD COLUMN "due_date" DATE;

-- Vade, düzenleme tarihinden önce olamaz: peşin fatura aynı gün vadeli
-- olur, geriye dönük vadeli olmaz. Yanlış girilmiş bir vade, ödeme
-- koşusunda o faturayı en tepeye taşır ve sırayı bozar.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_due_after_issue"
  CHECK ("due_date" IS NULL OR "due_date" >= "issued_at"::date);

-- Ödeme koşusu ve nakit akışı hep vadeye göre sıralar.
CREATE INDEX "invoices_due_idx" ON "invoices"("due_date");
CREATE INDEX "sales_invoices_due_idx" ON "sales_invoices"("due_date");
