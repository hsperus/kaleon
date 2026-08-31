-- 038 — Rota ana verisi, standart maliyet ve raf/göz yönetimi.
--
-- ── ROTA ──
--
-- ÖLÇÜLEN BOŞLUK: operasyonlar iş emrine GÖMÜLÜYDÜ. Her yeni iş
-- emrinde aynı operasyon dizisi elle yazılıyordu ve bir tanesinde
-- süre yanlış girildiğinde yalnızca o iş emri yanlış oluyordu —
-- ama kimse fark etmiyordu çünkü karşılaştırılacak bir "doğru" yoktu.
--
-- Rota o doğruyu tanımlar: bu ürün şu iş merkezlerinde, şu sürelerde
-- üretilir. İş emri rotadan türer; sapma ölçülebilir hâle gelir.

CREATE TABLE "routings" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Aynı ürünün iki üretim yolu olabilir: elde ve robotla.
    -- Hangisinin kullanılacağı üretim versiyonunda belirlenir.
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "routings_code" ON "routings"("code");
CREATE INDEX "routings_item" ON "routings"("item_id", "is_active");

CREATE TABLE "routing_operations" (
    "id" UUID NOT NULL,
    "routing_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "work_center_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    -- HAZIRLIK VE İŞLEME AYRI TUTULUR.
    --
    -- Tek bir "süre" alanı olsaydı, 10 adetlik parti ile 1000 adetlik
    -- parti aynı birim süreyle hesaplanırdı. Oysa hazırlık parti
    -- başına bir kez, işleme her adet için harcanır — küçük partide
    -- birim maliyeti belirleyen şey hazırlıktır.
    "setup_minutes" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "run_minutes_per_unit" DECIMAL(10,4) NOT NULL DEFAULT 0,
    CONSTRAINT "routing_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_operations_times"
      CHECK ("setup_minutes" >= 0 AND "run_minutes_per_unit" >= 0),
    CONSTRAINT "routing_operations_routing_fk"
      FOREIGN KEY ("routing_id") REFERENCES "routings"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "routing_operations_seq" ON "routing_operations"("routing_id", "seq");

-- ── ÜRETİM VERSİYONU ──
--
-- BOM + rota eşleşmesi. Aynı ürünün iki üretim yolu varsa (elde /
-- robotla), her yol kendi BOM'u ve rotasıyla tanımlanır.

CREATE TABLE "production_versions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "bom_revision" TEXT NOT NULL,
    "routing_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "production_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "production_versions_period"
      CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);

CREATE UNIQUE INDEX "production_versions_code" ON "production_versions"("code");
-- BİR ÜRÜNÜN TEK VARSAYILAN VERSİYONU OLUR. İki varsayılan, hangisinin
-- kullanılacağını belirsiz bırakır ve iş emri her seferinde farklı
-- maliyet üretir.
CREATE UNIQUE INDEX "production_versions_default"
  ON "production_versions"("item_id") WHERE "is_default" = true;

-- ── STANDART MALİYET ──
--
-- Rota ve BOM'dan hesaplanan ÖN maliyet. Gerçekleşenle farkı
-- "sapma"dır ve sapma, üretimin nerede kaybettiğini gösteren tek
-- ölçüdür.

CREATE TABLE "standard_costs" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    -- Üç bileşen AYRI tutulur: hangi bileşende sapıldığı, toplam
    -- sapmadan çok daha kullanışlı bir bilgidir.
    "material_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "labor_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "overhead_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "set_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standard_costs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "standard_costs_positive"
      CHECK ("material_cost" >= 0 AND "labor_cost" >= 0 AND "overhead_cost" >= 0),
    CONSTRAINT "standard_costs_year" CHECK ("year" BETWEEN 2000 AND 2100)
);

CREATE UNIQUE INDEX "standard_costs_unique" ON "standard_costs"("item_id", "year");

-- ── RAF / GÖZ ──
--
-- Lokasyon vardı, içindeki adres yoktu: "IST-TEK deposunda 640 litre
-- var" biliniyordu ama hangi rafta olduğu bilinmiyordu. 200 m²'lik
-- bir depoda bu, malı aramak demektir.

CREATE TABLE "storage_bins" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    -- Kapasite bilinmiyorsa null; sıfır DEĞİL. Sıfır kapasite
    -- "buraya hiçbir şey konamaz" demektir ve o ayrı bir durumdur.
    "capacity" DECIMAL(18,4),
    "capacity_uom" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "storage_bins_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_bins_capacity" CHECK ("capacity" IS NULL OR "capacity" > 0),
    CONSTRAINT "storage_bins_location_fk"
      FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "storage_bins_code" ON "storage_bins"("location_id", "code");

-- Stok hareketine raf boyutu. NULL kalabilir: raf yönetimi
-- kullanılmayan depolarda ve geçmiş hareketlerde doğru olan budur.
ALTER TABLE "stock_movements" ADD COLUMN "bin_code" TEXT;

CREATE INDEX "stock_movements_bin_idx"
  ON "stock_movements"("location_id", "bin_code", "item_id");
