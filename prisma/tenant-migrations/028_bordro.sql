-- 028 — Bordro.
--
-- İK modülünde izin, vardiya ve kıdem hesabı vardı; BORDRO YOKTU.
-- Yani sistem "bu çalışanın izni ne kadar" sorusunu cevaplıyor ama
-- "bu ay ne ödeyeceğim" sorusunu cevaplamıyordu — oysa işletmenin en
-- büyük ikinci gider kalemi budur ve her ay tekrar eder.
--
-- KÜMÜLATİF MATRAH SAKLANIR, YENİDEN HESAPLANMAZ. Gelir vergisi yıl
-- başından biriken matrah üzerinden hesaplanır. Her bordroda geçmiş
-- aylar yeniden hesaplansaydı, geçmişte düzeltilmiş bir kalem bugünkü
-- vergiyi değiştirir ve ödenmiş bordrolar geriye dönük olarak
-- tutarsızlaşırdı. O ayın matrahı o ay DONAR.
--
-- BİR DÖNEM İKİ KEZ ÇALIŞTIRILAMAZ: (period, employee_id)
-- benzersizliği bunu veritabanı seviyesinde engeller. Çift bordro,
-- çift SGK bildirimi ve çift ödeme demektir.

CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    -- Dönem: ayın ilk günü (2026-03-01).
    "period" DATE NOT NULL,
    -- draft | posted
    "status" TEXT NOT NULL DEFAULT 'posted',
    "employee_count" INTEGER NOT NULL,
    "total_gross" DECIMAL(18,2) NOT NULL,
    "total_net" DECIMAL(18,2) NOT NULL,
    "total_employer_cost" DECIMAL(18,2) NOT NULL,
    "journal_document_no" TEXT,
    -- Hesapta kullanılan parametre kümesinin yılı — geriye dönük
    -- denetimde "hangi oranlarla hesaplandı" sorusunun cevabı.
    "parameter_year" INTEGER NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_by" UUID,
    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payroll_runs_period_key" ON "payroll_runs"("period");

CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period" DATE NOT NULL,

    "gross_salary" DECIMAL(18,2) NOT NULL,
    "bonus" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_gross" DECIMAL(18,2) NOT NULL,
    "sgk_base" DECIMAL(18,2) NOT NULL,
    "employee_sgk" DECIMAL(18,2) NOT NULL,
    "employee_unemployment" DECIMAL(18,2) NOT NULL,
    "tax_base" DECIMAL(18,2) NOT NULL,
    -- Bu ay ÖNCESİNDEKİ kümülatif matrah — donmuş hâliyle saklanır.
    "cumulative_before" DECIMAL(18,2) NOT NULL,
    "cumulative_after" DECIMAL(18,2) NOT NULL,
    "gross_income_tax" DECIMAL(18,2) NOT NULL,
    "income_tax_exemption" DECIMAL(18,2) NOT NULL,
    "income_tax" DECIMAL(18,2) NOT NULL,
    "stamp_duty" DECIMAL(18,2) NOT NULL,
    "total_deductions" DECIMAL(18,2) NOT NULL,
    "net_salary" DECIMAL(18,2) NOT NULL,
    "employer_sgk" DECIMAL(18,2) NOT NULL,
    "employer_unemployment" DECIMAL(18,2) NOT NULL,
    "employer_cost" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_lines_run_fkey" FOREIGN KEY ("run_id")
        REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
    CONSTRAINT "payroll_lines_employee_fkey" FOREIGN KEY ("employee_id")
        REFERENCES "employees"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "payroll_lines_period_employee_key"
    ON "payroll_lines"("period", "employee_id");
CREATE INDEX "payroll_lines_employee_idx" ON "payroll_lines"("employee_id");

-- Ödenmiş bordro DEĞİŞTİRİLEMEZ. Değiştirilebilseydi SGK'ya bildirilen
-- tutar ile sistemdeki tutar ayrışır ve hangisinin doğru olduğu
-- anlaşılamazdı. Düzeltme yolu ek bordro ya da ters kayıttır.
CREATE OR REPLACE FUNCTION "payroll_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Çalıştırılmış bordro değiştirilemez veya silinemez. Düzeltme için ek bordro düzenlenir.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payroll_lines_immutable"
    BEFORE UPDATE OR DELETE ON "payroll_lines"
    FOR EACH ROW EXECUTE FUNCTION "payroll_immutable"();
