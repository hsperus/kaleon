-- 022 — Bakım yönetimi (PM/EAM).
--
-- ALTI ANA SÜREÇTEN HİÇ DOKUNULMAMIŞ TEK SÜREÇTİ. Makine kartı ve
-- anlık durum vardı (WIP hesabı için), ama bakım planı, arıza bildirimi
-- ve bakım iş emri yoktu.
--
-- Bir imalat KOBİ'sinde duran tezgâh, eksik malzemeden pahalıdır:
-- malzeme gecikirse sipariş kayar, tezgâh arızalanırsa o gün üretilecek
-- her şey kayar ve tamir süresi tahmin edilemez. Buna rağmen bakım çoğu
-- KOBİ'de bir defterde ya da ustabaşının aklında durur — ve ustabaşı
-- ayrılınca hafıza da gider.

CREATE TABLE "maintenance_plans" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'planli',
    "interval_days" INTEGER,
    "interval_hours" DECIMAL(12,2),
    "last_done_at" DATE,
    "last_done_hours" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "maintenance_plans_machine_active_idx"
  ON "maintenance_plans"("machine_code", "is_active");

-- ARALIKSIZ PLAN OLMAZ. Ne takvim ne sayaç aralığı verilmemişse plan
-- hiçbir zaman tetiklenmez ve "bakım planımız var" yanılsaması doğar.
ALTER TABLE "maintenance_plans"
  ADD CONSTRAINT "maintenance_plans_has_interval"
    CHECK ("interval_days" IS NOT NULL OR "interval_hours" IS NOT NULL),
  ADD CONSTRAINT "maintenance_plans_interval_positive"
    CHECK (("interval_days" IS NULL OR "interval_days" > 0)
       AND ("interval_hours" IS NULL OR "interval_hours" > 0));

CREATE TABLE "maintenance_orders" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "machine_code" TEXT NOT NULL,
    "plan_id" UUID,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "description" TEXT NOT NULL,
    "scheduled_for" DATE,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "labor_hours" DECIMAL(10,2),
    "parts_cost" DECIMAL(18,2),
    "findings" TEXT,
    "assigned_to" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "maintenance_orders_document_no_key" ON "maintenance_orders"("document_no");
CREATE INDEX "maintenance_orders_machine_status_idx" ON "maintenance_orders"("machine_code", "status");
CREATE INDEX "maintenance_orders_status_idx" ON "maintenance_orders"("status");

ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_plan_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "maintenance_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "maintenance_orders"
  ADD CONSTRAINT "maintenance_orders_kind_valid"
    CHECK ("kind" IN ('planli', 'ariza', 'kestirimci')),
  ADD CONSTRAINT "maintenance_orders_status_valid"
    CHECK ("status" IN ('planned', 'released', 'in_progress', 'completed', 'cancelled')),
  -- BİTİŞ BAŞLANGIÇTAN ÖNCE OLAMAZ. Olsaydı negatif tamir süresi doğar
  -- ve MTTR ortalaması sessizce bozulurdu.
  ADD CONSTRAINT "maintenance_orders_time_order"
    CHECK ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at");

CREATE TABLE "breakdowns" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL,
    "reported_by" UUID NOT NULL,
    "severity" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "order_id" UUID,
    "root_cause" TEXT,
    CONSTRAINT "breakdowns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "breakdowns_order_id_key" ON "breakdowns"("order_id");
CREATE INDEX "breakdowns_machine_reported_idx" ON "breakdowns"("machine_code", "reported_at");
CREATE INDEX "breakdowns_severity_idx" ON "breakdowns"("severity");

ALTER TABLE "breakdowns" ADD CONSTRAINT "breakdowns_order_fkey"
  FOREIGN KEY ("order_id") REFERENCES "maintenance_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "breakdowns"
  ADD CONSTRAINT "breakdowns_severity_valid"
    CHECK ("severity" IN ('durdurdu', 'yavaslatti', 'etkilemedi')),
  ADD CONSTRAINT "breakdowns_time_order"
    CHECK ("resolved_at" IS NULL OR "resolved_at" >= "reported_at");
