-- 009 — Parti (lot) izleme ve şecere.
--
-- ÖNCESİNDE `batch_id` ÇIPLAK BİR METİNDİ. Stok hareketinde ve irsaliye
-- satırında bir parti numarası yazıyordu ama arkasında hiçbir kayıt yoktu:
-- son kullanma tarihi, karantina durumu, tedarikçinin kendi numarası ve en
-- önemlisi PARTİLER ARASI BAĞ hiçbir yerde tutulmuyordu.
--
-- Bunun pratik sonucu şudur: "bu partiden kime ne gitti" ve "bu parti
-- neyden yapıldı" sorularının cevabı veritabanında YOKTU. Gıda ve kimyada
-- bu iki soruya saatler içinde cevap verememek, geri çağırmayı tüm üretime
-- yaymak demektir.

CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "batch_no" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "origin" TEXT NOT NULL,
    "produced_at" TIMESTAMP(3) NOT NULL,
    "expiry_date" DATE,
    "supplier_batch_no" TEXT,
    "supplier_id" TEXT,
    "work_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- PARTİ NUMARASI MALZEME İÇİNDE BENZERSİZDİR. Global benzersizlik,
-- tedarikçinin verdiği gerçek numarayı değiştirmeye zorlardı.
CREATE UNIQUE INDEX "batches_item_id_batch_no_key" ON "batches"("item_id", "batch_no");
CREATE INDEX "batches_status_idx" ON "batches"("status");
CREATE INDEX "batches_expiry_date_idx" ON "batches"("expiry_date");

ALTER TABLE "batches"
  ADD CONSTRAINT "batches_status_valid"
    CHECK ("status" IN ('available', 'quarantine', 'blocked', 'consumed')),
  ADD CONSTRAINT "batches_origin_valid"
    CHECK ("origin" IN ('satin_alma', 'uretim'));

CREATE TABLE "batch_genealogy" (
    "id" UUID NOT NULL,
    "input_batch_id" UUID NOT NULL,
    "output_batch_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "work_order_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "batch_genealogy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "batch_genealogy_input_output_wo_key"
  ON "batch_genealogy"("input_batch_id", "output_batch_id", "work_order_id");
CREATE INDEX "batch_genealogy_output_batch_id_idx" ON "batch_genealogy"("output_batch_id");

ALTER TABLE "batch_genealogy" ADD CONSTRAINT "batch_genealogy_input_fkey"
  FOREIGN KEY ("input_batch_id") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_genealogy" ADD CONSTRAINT "batch_genealogy_output_fkey"
  FOREIGN KEY ("output_batch_id") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BİR PARTİ KENDİNDEN DOĞAMAZ. Kendine bağ, izleme sorgusunu sonsuz
-- döngüye sokar; özyinelemeli sorguda derinlik sınırı bunu gizler ama
-- cevabı sessizce eksik bırakır.
ALTER TABLE "batch_genealogy"
  ADD CONSTRAINT "batch_genealogy_no_self" CHECK ("input_batch_id" <> "output_batch_id"),
  ADD CONSTRAINT "batch_genealogy_quantity_positive" CHECK ("quantity" > 0);
