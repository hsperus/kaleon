-- 039 — Çok adımlı işlem planı.
--
-- ÖLÇÜLEN DAVRANIŞ: "Şu üç müşteriye fatura kes ve e-Fatura gönder"
-- dendiğinde her adım AYRI bir onay turuna giriyordu. Kullanıcı altı
-- kez onaylıyor, ara adımlardan biri hata verirse geri kalanı
-- SESSİZCE düşüyordu. Ne yapıldığını, ne yapılmadığını söyleyen
-- hiçbir şey yoktu.
--
-- Plan bunu tersine çevirir: kullanıcı BİR kez onaylar, adımlar
-- sırayla koşar, her adımın sonucu ayrı kaydedilir ve yarıda kalan
-- adım AÇIKÇA bildirilir.
--
-- ─────────────────────────────────────────────────────────────────
--
-- PLAN YETKİ YÜKSELTMEZ.
--
-- `required_authority` adımların EN YÜKSEĞİdir. Bir L3 ödeme adımını
-- L2 onaylanmış bir planın içine gizlemek mümkün olmamalı; olsaydı
-- onay kapısı, planın içine saklanarak aşılan bir kapı olurdu.
--
-- BAŞARISIZ ADIM PLANI DURDURUR.
--
-- İmalatta adım 3 genelde adım 2'ye bağlıdır (fatura → e-Fatura).
-- Hata sonrası devam etmek yarı tutarlı veri üretir. Duran plan
-- sessiz kalmaz: hangi adımın neden düştüğü ve hangilerinin hiç
-- çalışmadığı ayrı ayrı yazılır.

CREATE TABLE "operation_plans" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    -- Planı doğuran soru: "bu plan neden yapıldı" sorusunun cevabı.
    "question" TEXT,
    -- draft | approved | running | completed | failed | cancelled
    "status" TEXT NOT NULL DEFAULT 'draft',
    -- Adımların en yüksek yetki seviyesi.
    "required_authority" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "conversation_id" TEXT,
    CONSTRAINT "operation_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operation_plans_status"
      CHECK ("status" IN ('draft', 'approved', 'running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT "operation_plans_authority" CHECK ("required_authority" BETWEEN 0 AND 3),
    -- ONAYLANMIŞ PLANIN ONAYLAYANI VARDIR. Onaysız bir "approved"
    -- kaydı, kimin sorumlu olduğu bilinmeyen bir işlem demektir.
    CONSTRAINT "operation_plans_approved_by"
      CHECK ("status" IN ('draft', 'cancelled') OR "approved_by" IS NOT NULL)
);

CREATE UNIQUE INDEX "operation_plans_no" ON "operation_plans"("document_no");
CREATE INDEX "operation_plans_status_idx" ON "operation_plans"("status", "created_at");
CREATE INDEX "operation_plans_user" ON "operation_plans"("created_by", "created_at");

CREATE TABLE "operation_plan_steps" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    -- pending | done | failed | skipped
    --
    -- "skipped" AYRI BİR DURUMDUR ve en önemlisidir: önceki adım
    -- düştüğü için hiç denenmemiş adım, denenip başarısız olmuş
    -- adımla aynı şey değildir. İkisini tek duruma indirgemek,
    -- kullanıcıya neyin yapılabilir olduğunu söylemez.
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result_summary" TEXT,
    "error_code" TEXT,
    "ran_at" TIMESTAMP(3),
    CONSTRAINT "operation_plan_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operation_plan_steps_status"
      CHECK ("status" IN ('pending', 'done', 'failed', 'skipped')),
    CONSTRAINT "operation_plan_steps_plan_fk"
      FOREIGN KEY ("plan_id") REFERENCES "operation_plans"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "operation_plan_steps_seq" ON "operation_plan_steps"("plan_id", "seq");
CREATE INDEX "operation_plan_steps_status_idx" ON "operation_plan_steps"("plan_id", "status");
