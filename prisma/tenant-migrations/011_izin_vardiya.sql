-- 011 — İzin ve vardiya.
--
-- ÖNCESİNDE PUANTAJ VARDI AMA İZİN YOKTU. Sistem kimin ne kadar çalıştığını
-- biliyordu, ama kimin ne kadar izin hakkı olduğunu bilmiyordu — oysa
-- yıllık izin bir muhasebe kalemidir (kullanılmayan izin karşılığı) ve
-- işten ayrılışta ödenmesi zorunludur.
--
-- HAK BU TABLOLARDA SAKLANMAZ, KANUNDAN HESAPLANIR. Saklansaydı, kıdem
-- yılı dolduğunda kimse güncellemeyi hatırlamaz ve çalışan eski hakkıyla
-- kalırdı. Burada yalnızca kanunun hesaplayamayacağı şey durur: devreden
-- gün ve elle düzeltmeler.

CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "working_days" DECIMAL(5,1) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "reason" TEXT,
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_requests_employee_id_start_date_idx" ON "leave_requests"("employee_id", "start_date");
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_date_order" CHECK ("end_date" >= "start_date"),
  ADD CONSTRAINT "leave_requests_days_positive" CHECK ("working_days" > 0),
  -- KENDİ İZNİNİ ONAYLAYAMAZ — veritabanı seviyesinde, satın alma
  -- talebindeki kuralın aynısı.
  ADD CONSTRAINT "leave_requests_self_approval"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by");

CREATE TABLE "leave_adjustments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "days" DECIMAL(5,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_adjustments_employee_year_reason_key"
  ON "leave_adjustments"("employee_id", "year", "reason");
CREATE INDEX "leave_adjustments_employee_year_idx" ON "leave_adjustments"("employee_id", "year");

CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TEXT NOT NULL,
    "ends_at" TEXT NOT NULL,
    "break_minutes" INTEGER NOT NULL,
    "is_night" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shifts_code_key" ON "shifts"("code");

ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_break_nonneg" CHECK ("break_minutes" >= 0);

CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- BİR KİŞİ AYNI GÜN İKİ VARDİYADA OLAMAZ. Olabilseydi mesai iki kez
-- hesaplanır ve bordro şişerdi.
CREATE UNIQUE INDEX "shift_assignments_employee_work_date_key"
  ON "shift_assignments"("employee_id", "work_date");
CREATE INDEX "shift_assignments_work_date_idx" ON "shift_assignments"("work_date");

ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_fkey"
  FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
