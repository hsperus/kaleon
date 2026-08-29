-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AliasSource" AS ENUM ('observed', 'confirmed', 'automatic');

-- CreateEnum
CREATE TYPE "TaxIdKind" AS ENUM ('vkn', 'tckn', 'vat');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('plant', 'warehouse', 'storage_location', 'work_center', 'office');

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "is_supplier" BOOLEAN NOT NULL DEFAULT false,
    "is_customer" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT NOT NULL DEFAULT 'TR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "merged_into" UUID,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_aliases" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "source" "AliasSource" NOT NULL DEFAULT 'observed',
    "confidence" DECIMAL(4,3) NOT NULL,
    "confirmed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_tax_ids" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "kind" "TaxIdKind" NOT NULL,
    "value" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'TR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_tax_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_external_refs" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_external_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "hired_at" DATE NOT NULL,
    "terminated_at" DATE,
    "gross_salary" DECIMAL(14,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "parent_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "user_id" UUID NOT NULL,
    "roles" TEXT[],
    "channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "authority" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "result_summary" JSONB,
    "error_code" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "ai_model" TEXT,
    "ai_prompt_version" TEXT,
    "ai_tool_use_id" TEXT,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "status" TEXT NOT NULL,
    "bom_revision" TEXT,
    "bom_frozen_at" TIMESTAMP(3),
    "override_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "planned_end_date" DATE,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_operations" (
    "id" UUID NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "work_center" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "gate_characteristic" TEXT,
    "gate_decided_by" TEXT,
    "gate_tolerance_min" DECIMAL(18,4),
    "gate_tolerance_max" DECIMAL(18,4),
    "gate_tolerance_unit" TEXT,
    "state" TEXT NOT NULL,
    "confirmed_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrap_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "gate_decision" JSONB,

    CONSTRAINT "work_order_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_revisions" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bom_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "direction" INTEGER NOT NULL,
    "movement_type" TEXT NOT NULL,
    "reference_kind" TEXT,
    "reference_id" TEXT,
    "user_id" UUID NOT NULL,
    "reason" TEXT,
    "reversal_of" UUID,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ordered_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "po_line_no" INTEGER NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "movement_id" UUID,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "document_no" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "match_status" TEXT NOT NULL DEFAULT 'pending',
    "total_variance" DECIMAL(18,4),
    "matched_at" TIMESTAMP(3),
    "raw_payload_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "po_id" TEXT,
    "po_line_no" INTEGER,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_findings" (
    "id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "impact" DECIMAL(18,4) NOT NULL,
    "detail" JSONB NOT NULL,

    CONSTRAINT "invoice_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_workspaces" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "prepared_by" UUID NOT NULL,
    "approved_by" UUID,
    "amount" DECIMAL(18,4),
    "currency" TEXT,
    "required_permission" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "risks" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "approval_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_events" (
    "id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "note" TEXT,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_payloads" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_payloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_errors" (
    "id" UUID NOT NULL,
    "raw_payload_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "integration_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "bank" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "iban" TEXT,
    "currency" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_balance_snapshots" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "available" DECIMAL(18,2) NOT NULL,
    "blocked" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "raw_payload_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "worked_minutes" INTEGER NOT NULL,
    "planned_minutes" INTEGER NOT NULL,
    "is_weekend" BOOLEAN NOT NULL DEFAULT false,
    "is_holiday" BOOLEAN NOT NULL DEFAULT false,
    "approved_at" TIMESTAMP(3),
    "approved_by" UUID,
    "raw_payload_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "order_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "committed_date" DATE NOT NULL,
    "penalty_per_day" DECIMAL(18,2),
    "penalty_cap" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "work_order_id" TEXT,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_code_key" ON "partners"("code");

-- CreateIndex
CREATE INDEX "partners_normalized_idx" ON "partners"("normalized");

-- CreateIndex
CREATE INDEX "partners_merged_into_idx" ON "partners"("merged_into");

-- CreateIndex
CREATE INDEX "partner_aliases_normalized_idx" ON "partner_aliases"("normalized");

-- CreateIndex
CREATE UNIQUE INDEX "partner_aliases_partner_id_normalized_key" ON "partner_aliases"("partner_id", "normalized");

-- CreateIndex
CREATE INDEX "partner_tax_ids_value_idx" ON "partner_tax_ids"("value");

-- CreateIndex
CREATE UNIQUE INDEX "partner_tax_ids_country_kind_value_key" ON "partner_tax_ids"("country", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "partner_external_refs_system_external_id_key" ON "partner_external_refs"("system", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_code_key" ON "employees"("code");

-- CreateIndex
CREATE INDEX "employees_normalized_idx" ON "employees"("normalized");

-- CreateIndex
CREATE INDEX "employees_department_idx" ON "employees"("department");

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "audit_entries_at_idx" ON "audit_entries"("at");

-- CreateIndex
CREATE INDEX "audit_entries_user_id_at_idx" ON "audit_entries"("user_id", "at");

-- CreateIndex
CREATE INDEX "audit_entries_tool_name_at_idx" ON "audit_entries"("tool_name", "at");

-- CreateIndex
CREATE INDEX "audit_entries_correlation_id_idx" ON "audit_entries"("correlation_id");

-- CreateIndex
CREATE INDEX "work_orders_status_idx" ON "work_orders"("status");

-- CreateIndex
CREATE INDEX "work_orders_item_id_idx" ON "work_orders"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_operations_work_order_id_seq_key" ON "work_order_operations"("work_order_id", "seq");

-- CreateIndex
CREATE INDEX "bom_revisions_item_id_is_active_idx" ON "bom_revisions"("item_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "bom_revisions_item_id_revision_key" ON "bom_revisions"("item_id", "revision");

-- CreateIndex
CREATE INDEX "stock_movements_item_id_location_id_batch_id_idx" ON "stock_movements"("item_id", "location_id", "batch_id");

-- CreateIndex
CREATE INDEX "stock_movements_reversal_of_idx" ON "stock_movements"("reversal_of");

-- CreateIndex
CREATE INDEX "stock_movements_at_idx" ON "stock_movements"("at");

-- CreateIndex
CREATE INDEX "purchase_orders_partner_id_idx" ON "purchase_orders"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_po_id_line_no_key" ON "purchase_order_lines"("po_id", "line_no");

-- CreateIndex
CREATE INDEX "goods_receipts_po_id_po_line_no_idx" ON "goods_receipts"("po_id", "po_line_no");

-- CreateIndex
CREATE INDEX "invoices_match_status_idx" ON "invoices"("match_status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_partner_id_document_no_key" ON "invoices"("partner_id", "document_no");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoice_id_line_no_key" ON "invoice_lines"("invoice_id", "line_no");

-- CreateIndex
CREATE INDEX "invoice_findings_invoice_id_idx" ON "invoice_findings"("invoice_id");

-- CreateIndex
CREATE INDEX "approval_workspaces_state_idx" ON "approval_workspaces"("state");

-- CreateIndex
CREATE INDEX "approval_workspaces_kind_state_idx" ON "approval_workspaces"("kind", "state");

-- CreateIndex
CREATE INDEX "approval_events_workspace_id_idx" ON "approval_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_events_workspace_id_seq_key" ON "approval_events"("workspace_id", "seq");

-- CreateIndex
CREATE INDEX "raw_payloads_kind_status_idx" ON "raw_payloads"("kind", "status");

-- CreateIndex
CREATE INDEX "raw_payloads_received_at_idx" ON "raw_payloads"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "raw_payloads_source_external_id_key" ON "raw_payloads"("source", "external_id");

-- CreateIndex
CREATE INDEX "sync_runs_source_started_at_idx" ON "sync_runs"("source", "started_at");

-- CreateIndex
CREATE INDEX "integration_errors_resolved_at_idx" ON "integration_errors"("resolved_at");

-- CreateIndex
CREATE INDEX "bank_accounts_currency_idx" ON "bank_accounts"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_external_id_currency_key" ON "bank_accounts"("external_id", "currency");

-- CreateIndex
CREATE INDEX "bank_balance_snapshots_account_id_as_of_idx" ON "bank_balance_snapshots"("account_id", "as_of" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "bank_balance_snapshots_account_id_as_of_key" ON "bank_balance_snapshots"("account_id", "as_of");

-- CreateIndex
CREATE INDEX "attendance_days_work_date_idx" ON "attendance_days"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_employee_id_work_date_key" ON "attendance_days"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_order_no_key" ON "sales_orders"("order_no");

-- CreateIndex
CREATE INDEX "sales_orders_status_committed_date_idx" ON "sales_orders"("status", "committed_date");

-- CreateIndex
CREATE INDEX "sales_orders_partner_id_idx" ON "sales_orders"("partner_id");

-- CreateIndex
CREATE INDEX "sales_order_lines_work_order_id_idx" ON "sales_order_lines"("work_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_sales_order_id_line_no_key" ON "sales_order_lines"("sales_order_id", "line_no");

-- AddForeignKey
ALTER TABLE "partner_aliases" ADD CONSTRAINT "partner_aliases_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_tax_ids" ADD CONSTRAINT "partner_tax_ids_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_external_refs" ADD CONSTRAINT "partner_external_refs_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_operations" ADD CONSTRAINT "work_order_operations_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_findings" ADD CONSTRAINT "invoice_findings_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "approval_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_errors" ADD CONSTRAINT "integration_errors_raw_payload_id_fkey" FOREIGN KEY ("raw_payload_id") REFERENCES "raw_payloads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_balance_snapshots" ADD CONSTRAINT "bank_balance_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

