-- 025 — Sabit kıymet ve amortisman.
--
-- SAP'DE ASSET ACCOUNTING AYRI BİR MODÜLDÜR; burada hiç yoktu. Oysa
-- amortisman vergi matrahını doğrudan değiştirir ve her işletmede
-- vardır: makine, taşıt, demirbaş, bilgisayar. Amortismanı Excel'de
-- tutan bir işletme, ERP'nin en pahalı çıktısını (mali tablo)
-- sistemin dışında üretiyor demektir.
--
-- BİR YIL İKİ KEZ AYRILAMAZ. `(asset_id, year)` benzersizliği bunu
-- veritabanı seviyesinde engelliyor: uygulama iki kez çağrılsa bile
-- ikincisi reddedilir. Çift ayrılan amortisman matrahı yarı yarıya
-- düşürür ve incelemede cezalı tarhiyata yol açar.

CREATE TABLE "fixed_assets" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- makine | tasit | demirbas | bilgisayar | bina | diger
    "category" TEXT NOT NULL,
    "acquired_at" DATE NOT NULL,
    -- Amortismana esas bedel: KDV hariç, montaj/nakliye dahil.
    "cost" DECIMAL(18,2) NOT NULL,
    "useful_life_years" INTEGER NOT NULL,
    -- normal | azalan
    "method" TEXT NOT NULL DEFAULT 'normal',
    -- Kıst amortisman (VUK 320) — yalnızca binek otomobilde true.
    "prorated" BOOLEAN NOT NULL DEFAULT false,
    -- Muhasebe hesapları: hangi hesaba kaydedildiği ve gideri nereye
    -- yazıldığı kıymete göre değişir (üretim makinesi 730, ofis 770).
    "asset_account" TEXT NOT NULL,
    "depreciation_account" TEXT NOT NULL DEFAULT '257',
    "expense_account" TEXT NOT NULL,
    -- aktif | tam_amorti | elden_cikarildi
    "status" TEXT NOT NULL DEFAULT 'aktif',
    "disposed_at" DATE,
    "disposal_proceeds" DECIMAL(18,2),
    "location_id" UUID,
    "serial" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fixed_assets_code_key" ON "fixed_assets"("code");
CREATE INDEX "fixed_assets_status_idx" ON "fixed_assets"("status");

-- Amortisman esas bedeli pozitif olmalı: sıfır bedelli bir kıymet
-- amortismana tabi değildir ve tabloyu kirletir.
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_cost_positive"
    CHECK ("cost" > 0);
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_life_positive"
    CHECK ("useful_life_years" >= 1);

CREATE TABLE "depreciation_runs" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accumulated" DECIMAL(18,2) NOT NULL,
    "book_value" DECIMAL(18,2) NOT NULL,
    "months" INTEGER NOT NULL,
    -- Hangi yevmiye fişine yazıldı — geri izleme için.
    "journal_document_no" TEXT,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_by" UUID,
    CONSTRAINT "depreciation_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "depreciation_runs_asset_fkey" FOREIGN KEY ("asset_id")
        REFERENCES "fixed_assets"("id") ON DELETE RESTRICT
);

-- BİR YIL İKİ KEZ AYRILAMAZ.
CREATE UNIQUE INDEX "depreciation_runs_asset_year_key"
    ON "depreciation_runs"("asset_id", "year");
CREATE INDEX "depreciation_runs_year_idx" ON "depreciation_runs"("year");

-- Ayrılmış amortisman DEĞİŞTİRİLEMEZ ve SİLİNEMEZ: yevmiyeye yazılmış
-- bir tutarın kaydını geri almak, defterle sistemi ayırır. Düzeltme
-- yolu ters kayıttır.
CREATE OR REPLACE FUNCTION "depreciation_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Ayrılmış amortisman değiştirilemez veya silinemez (%). Düzeltme için ters kayıt yazılır.', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "depreciation_runs_immutable"
    BEFORE UPDATE OR DELETE ON "depreciation_runs"
    FOR EACH ROW EXECUTE FUNCTION "depreciation_immutable"();
