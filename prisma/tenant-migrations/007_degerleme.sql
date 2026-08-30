-- 007 — Stok değerleme ve döviz kuru.
--
-- ÖNCESİNDE MALİYET HİÇ HESAPLANMIYORDU. `items.moving_avg_cost` alanı
-- vardı ama hiçbir kod onu güncellemiyordu; yani "gerçek kârlılık" vaadi
-- veritabanında karşılıksızdı. Stok hareketlerinin de değeri yoktu: bir
-- çıkışın şirkete kaça mal olduğu kayıtlı değildi.
--
-- Döviz kuru ise hiç yoktu. EUR bir alacak TL'ye çevrilemiyordu ve
-- çevrilemediği için de ya atlanıyor ya da 1 kabul ediliyordu.
--
-- MEVCUT HAREKETLER DEĞERSİZ KALIR: geriye dönük maliyet uydurulmaz.
-- `unit_cost` null'dır ve raporda "maliyeti bilinmiyor" olarak ayrışır.

CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "quoted_at" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TCMB',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rates_currency_quoted_at_key" ON "exchange_rates"("currency", "quoted_at");
CREATE INDEX "exchange_rates_currency_quoted_at_idx" ON "exchange_rates"("currency", "quoted_at");

-- SIFIR VEYA NEGATİF KUR YAZILAMAZ. Sıfır kur, yabancı para tutarını
-- sıfırlar; negatif kur hiçbir anlam taşımaz. Uygulama kontrolü kullanıcıya
-- erken mesaj vermek içindir, tek savunma değildir.
ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0);

CREATE TABLE "item_cost_states" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity_on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,4),
    "total_value" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "item_cost_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "item_cost_states_item_id_key" ON "item_cost_states"("item_id");

-- MALİYET NEGATİF OLAMAZ. Bakiye eksiye düşebilir (fiziksel gerçek), ama
-- birim maliyetin negatifi bir hesap hatasıdır ve sessizce yayılır.
ALTER TABLE "item_cost_states"
  ADD CONSTRAINT "item_cost_states_unit_cost_nonneg" CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0);

ALTER TABLE "stock_movements"
  ADD COLUMN "unit_cost" DECIMAL(18,4),
  ADD COLUMN "value" DECIMAL(18,2),
  ADD COLUMN "source_currency" TEXT,
  ADD COLUMN "exchange_rate" DECIMAL(18,6);
