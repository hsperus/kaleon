-- 015 — Onay bekleyen işlemler.
--
-- ÖNCESİNDE YAZMA TOOL'LARI DOĞRUDAN ÇALIŞIYORDU. Model `issue_sales_invoice`
-- çağırdığında fatura kesiliyordu; aradaki tek engel sistem promptundaki
-- "önce onay al" talimatıydı. Yani anayasadaki "AI hazırlar, sistem
-- doğrular, İNSAN ONAYLAR" zincirinin son halkası KARŞILIKSIZDI: kural
-- vardı ama uygulanmasını garanti eden bir mekanizma yoktu.
--
-- Prompt bir koruma değildir. Model yanılabilir, kullanıcı cümlesi yanlış
-- anlaşılabilir, bir jailbreak denemesi geçebilir — üçünde de fatura
-- kesilmiş ve geri alınamaz olur.
--
-- Bu tablo aynı zamanda VERİ GİRİŞ FORMUNUN kaynağıdır: bekleyen işlemin
-- girdisi, kullanıcının düzeltip gönderdiği formun kendisidir.

CREATE TABLE "pending_actions" (
    "id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "authority" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "conversation_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pending_actions_user_status_idx"
  ON "pending_actions"("user_id", "status", "expires_at");
CREATE INDEX "pending_actions_status_expires_idx" ON "pending_actions"("status", "expires_at");

ALTER TABLE "pending_actions"
  ADD CONSTRAINT "pending_actions_status_valid"
    CHECK ("status" IN ('pending', 'confirmed', 'cancelled', 'expired'));
