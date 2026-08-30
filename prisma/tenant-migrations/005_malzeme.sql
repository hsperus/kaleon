-- 005 — Malzeme ana verisi, ölçü birimi çevrimi, BOM bileşenleri.
--
-- ÖNCESİNDE MALZEME NESNESİ YOKTU: `item_id` her yerde çıplak bir metindi.
-- Stok hareketi, iş emri, BOM, satın alma ve satış hep ona atıfta
-- bulunuyordu ama arkasında hiçbir kayıt yoktu. Ölçü birimi, değerleme
-- yöntemi, parti kuralı ve tedarik süresi buraya asılır.
--
-- `bom_revisions` tablosu vardı ama İÇİNDE BİLEŞEN YOKTU: hangi üründen ne
-- kadar gerektiğini kimse bilmiyordu. Ürün ağacı olmadan MRP, maliyet
-- hesabı ve parti izleme imkânsızdır.

CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "base_uom" TEXT NOT NULL,
    "valuation_method" TEXT NOT NULL DEFAULT 'hareketli_ortalama',
    "standard_cost" DECIMAL(18,4),
    "moving_avg_cost" DECIMAL(18,4),
    "cost_currency" TEXT NOT NULL DEFAULT 'TRY',
    "batch_managed" BOOLEAN NOT NULL DEFAULT false,
    "serial_managed" BOOLEAN NOT NULL DEFAULT false,
    "shelf_life_days" INTEGER,
    "procurement_type" TEXT NOT NULL DEFAULT 'satin_alma',
    "lead_time_days" INTEGER,
    "reorder_point" DECIMAL(18,4),
    "safety_stock" DECIMAL(18,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "item_units" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "uom" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "item_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bom_lines" (
    "id" UUID NOT NULL,
    "bom_revision_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "component_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "scrap_percent" DECIMAL(6,3) NOT NULL DEFAULT 0,

    CONSTRAINT "bom_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "items_code_key" ON "items"("code");
CREATE INDEX "items_normalized_idx" ON "items"("normalized");
CREATE INDEX "items_type_is_active_idx" ON "items"("type", "is_active");
CREATE INDEX "item_units_item_id_idx" ON "item_units"("item_id");
CREATE UNIQUE INDEX "item_units_item_id_uom_key" ON "item_units"("item_id", "uom");
CREATE INDEX "bom_lines_component_id_idx" ON "bom_lines"("component_id");
CREATE UNIQUE INDEX "bom_lines_bom_revision_id_line_no_key" ON "bom_lines"("bom_revision_id", "line_no");

ALTER TABLE "item_units" ADD CONSTRAINT "item_units_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_revision_id_fkey" FOREIGN KEY ("bom_revision_id") REFERENCES "bom_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
