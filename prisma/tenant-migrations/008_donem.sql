-- 008 — Muhasebe dönemi ve dönem kapama.
--
-- ÖNCESİNDE HER TARİHE KAYIT GİRİLEBİLİYORDU. Beyanname verilmiş, mizanı
-- çıkmış bir aya sonradan giren tek bir stok hareketi, o beyannameyi
-- yanlış hâle getirir — ve kimse fark etmez: rapor bugün bir sayı, üç ay
-- sonra başka bir sayı verir.
--
-- KURAL İZİNLE DEĞİL TARİHLE ÇALIŞIR: kapalı dönem herkese kapalıdır,
-- patrona da. Yazılması gerekiyorsa dönem yeniden AÇILIR ve açma işlemi
-- sebebiyle birlikte kaydedilir.

CREATE TABLE "accounting_periods" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMP(3),
    "closed_by" UUID,
    "reopen_reason" TEXT,
    "reopened_at" TIMESTAMP(3),
    "reopened_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_periods_year_month_key" ON "accounting_periods"("year", "month");
CREATE INDEX "accounting_periods_status_idx" ON "accounting_periods"("status");

ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_month_range" CHECK ("month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "accounting_periods_status_valid"
    CHECK ("status" IN ('open', 'closed', 'locked'));

-- KİLİTLİ DÖNEM AÇILAMAZ — veritabanı seviyesinde.
--
-- Uygulama kontrolü yeterli değildir: bir betik, bir düzeltme sorgusu ya
-- da ileride yazılacak bir kod yolu bu kuralı atlayabilir. Kilit, yıl sonu
-- bilançosunun onaylandığı anlamına gelir; geri alınması bilançoyu
-- geçersiz kılar.
CREATE OR REPLACE FUNCTION "accounting_periods_locked_is_final"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'locked' THEN
      RAISE EXCEPTION 'Kilitli dönem silinemez: %/%', OLD."year", OLD."month";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'locked' AND NEW."status" <> 'locked' THEN
    RAISE EXCEPTION 'Kilitli dönem açılamaz: %/%. Yıl sonu bilançosu onaylanmıştır.',
      OLD."year", OLD."month";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "accounting_periods_locked_is_final_trg"
  BEFORE UPDATE OR DELETE ON "accounting_periods"
  FOR EACH ROW EXECUTE FUNCTION "accounting_periods_locked_is_final"();
