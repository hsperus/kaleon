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
    "tax_office" TEXT,
    "address_line" TEXT,
    "district" TEXT,
    "city" TEXT,
    "postal_code" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "einvoice_user" BOOLEAN,
    "einvoice_alias" TEXT,
    "payment_terms_days" INTEGER,
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
    "birth_date" DATE,
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
    "unit_cost" DECIMAL(18,4),
    "value" DECIMAL(18,2),
    "source_currency" TEXT,
    "exchange_rate" DECIMAL(18,6),

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
    "due_date" DATE,
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
    "over_delivery_tolerance" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cancelled_at" TIMESTAMP(3),
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
    "uom" TEXT NOT NULL DEFAULT 'adet',
    "unit_price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat_rate" INTEGER NOT NULL DEFAULT 20,
    "delivered_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "invoiced_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "work_order_id" TEXT,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_centers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "concurrent_capacity" INTEGER,
    "target_rate_per_hour" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "work_center_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_status_snapshots" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "running_hours" DECIMAL(12,2),
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_status_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_uploads" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "item_units" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "uom" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "item_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "document_number_ranges" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_number_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "location_id" TEXT NOT NULL,
    "shipped_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "carrier_name" TEXT,
    "plate_no" TEXT,
    "ettn" TEXT,
    "edespatch_status" TEXT,
    "driver_name" TEXT,
    "driver_tckn" TEXT,
    "actual_despatch_at" TIMESTAMP(3),
    "posted_at" TIMESTAMP(3),
    "posted_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_lines" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "order_line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "batch_id" TEXT,
    "movement_id" UUID,

    CONSTRAINT "delivery_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "sales_order_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "due_date" DATE,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "discount_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "einvoice_kind" TEXT,
    "ettn" TEXT,
    "einvoice_status" TEXT,
    "issued_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "delivery_id" UUID,
    "delivery_line_no" INTEGER,
    "order_line_no" INTEGER,
    "item_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat_rate" INTEGER NOT NULL,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "quoted_at" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TCMB',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_cost_states" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity_on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,4),
    "total_value" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_cost_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "batch_genealogy" (
    "id" UUID NOT NULL,
    "input_batch_id" UUID NOT NULL,
    "output_batch_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "work_order_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_genealogy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requisitions" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requested_by" UUID NOT NULL,
    "department" TEXT,
    "justification" TEXT,
    "estimated_total" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "rejected_by" UUID,
    "rejection_reason" TEXT,
    "purchase_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requisition_lines" (
    "id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "estimated_price" DECIMAL(18,4),
    "needed_by" DATE NOT NULL,

    CONSTRAINT "purchase_requisition_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "method" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "bank_account_id" TEXT,
    "reference" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_data_changes" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "object_code" TEXT,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "operation" TEXT NOT NULL,
    "changed_by" UUID,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_data_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "entry_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "total_debit" DECIMAL(18,2) NOT NULL,
    "total_credit" DECIMAL(18,2) NOT NULL,
    "reversed_by" UUID,
    "reversal_of" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_code" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "partner_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "fx_debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "fx_credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "fx_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_revaluations" (
    "id" UUID NOT NULL,
    "as_of" DATE NOT NULL,
    "entry_id" UUID,
    "difference" DECIMAL(18,2) NOT NULL,
    "line_count" INTEGER NOT NULL,
    "rates" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_revaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "count_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "counted_by" UUID,
    "posted_at" TIMESTAMP(3),
    "posted_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "system_qty" DECIMAL(18,4) NOT NULL,
    "counted_qty" DECIMAL(18,4),
    "unit_cost" DECIMAL(18,4),
    "counted_at" TIMESTAMP(3),

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_profile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "tax_office" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postal_code" TEXT,
    "country" TEXT NOT NULL DEFAULT 'TR',
    "email" TEXT,
    "phone" TEXT,
    "mersis_no" TEXT,
    "trade_registry_no" TEXT,
    "einvoice_alias" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_conditions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "partner_id" TEXT,
    "item_code" TEXT,
    "partner_group" TEXT,
    "min_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "value" DECIMAL(18,4) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_quotations" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "quoted_at" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rejection_reason" TEXT,
    "sales_order_no" TEXT,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_quotation_lines" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vat_rate" INTEGER NOT NULL DEFAULT 20,

    CONSTRAINT "sales_quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_rfqs" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "requisition_no" TEXT,
    "requested_at" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "awarded_quote_id" UUID,
    "award_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_quotes" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "partner_id" TEXT NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "lead_time_days" INTEGER,
    "valid_until" DATE,
    "note" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "serial_numbers" (
    "id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'stokta',
    "batch_id" TEXT,
    "produced_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "delivery_id" UUID,
    "partner_id" TEXT,
    "warranty_months" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serial_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "acquired_at" DATE NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL,
    "useful_life_years" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'normal',
    "prorated" BOOLEAN NOT NULL DEFAULT false,
    "asset_account" TEXT NOT NULL,
    "depreciation_account" TEXT NOT NULL DEFAULT '257',
    "expense_account" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'aktif',
    "disposed_at" DATE,
    "disposal_proceeds" DECIMAL(18,2),
    "location_id" UUID,
    "serial" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_runs" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accumulated" DECIMAL(18,2) NOT NULL,
    "book_value" DECIMAL(18,2) NOT NULL,
    "months" INTEGER NOT NULL,
    "journal_document_no" TEXT,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_by" UUID,

    CONSTRAINT "depreciation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_credit_notes" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "invoice_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "with_goods" BOOLEAN NOT NULL DEFAULT false,
    "location_id" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "ettn" TEXT,
    "einvoice_kind" TEXT,
    "einvoice_status" TEXT,
    "issued_by" UUID,
    "journal_document_no" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_credit_note_lines" (
    "id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "invoice_line_no" INTEGER,
    "item_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'adet',
    "unit_price" DECIMAL(18,4) NOT NULL,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "vat_rate" INTEGER NOT NULL DEFAULT 20,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "movement_id" UUID,

    CONSTRAINT "sales_credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "period" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "employee_count" INTEGER NOT NULL,
    "total_gross" DECIMAL(18,2) NOT NULL,
    "total_net" DECIMAL(18,2) NOT NULL,
    "total_employer_cost" DECIMAL(18,2) NOT NULL,
    "journal_document_no" TEXT,
    "parameter_year" INTEGER NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_by" UUID,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "path" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "level" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_value" DOUBLE PRECISION,
    "last_checked_at" TIMESTAMP(3),
    "last_fired_at" TIMESTAMP(3),
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "statement_no" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "opening_balance" DECIMAL(18,2) NOT NULL,
    "closing_balance" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "imported_by" UUID,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "value_date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT NOT NULL,
    "counterparty" TEXT,
    "counterparty_iban" TEXT,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "matched_by" UUID NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suggested_score" INTEGER,
    "note" TEXT,

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dunning_levels" (
    "id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "min_overdue_days" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "interest_rate" DECIMAL(6,3),

    CONSTRAINT "dunning_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dunning_notices" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "issued_at" DATE NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "oldest_overdue_days" INTEGER NOT NULL,
    "invoice_nos" TEXT[],
    "issued_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dunning_notices_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "partner_tax_ids_partner_id_idx" ON "partner_tax_ids"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_tax_ids_country_kind_value_key" ON "partner_tax_ids"("country", "kind", "value");

-- CreateIndex
CREATE INDEX "partner_external_refs_partner_id_idx" ON "partner_external_refs"("partner_id");

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
CREATE INDEX "invoices_due_date_idx" ON "invoices"("due_date");

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
CREATE INDEX "integration_errors_raw_payload_id_idx" ON "integration_errors"("raw_payload_id");

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

-- CreateIndex
CREATE UNIQUE INDEX "work_centers_code_key" ON "work_centers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "machines_code_key" ON "machines"("code");

-- CreateIndex
CREATE INDEX "machines_work_center_id_idx" ON "machines"("work_center_id");

-- CreateIndex
CREATE INDEX "machine_status_snapshots_machine_id_as_of_idx" ON "machine_status_snapshots"("machine_id", "as_of" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "machine_status_snapshots_machine_id_as_of_key" ON "machine_status_snapshots"("machine_id", "as_of");

-- CreateIndex
CREATE INDEX "conversations_user_id_updated_at_idx" ON "conversations"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_conversation_id_seq_key" ON "conversation_messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "file_uploads_expires_at_idx" ON "file_uploads"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "items_code_key" ON "items"("code");

-- CreateIndex
CREATE INDEX "items_normalized_idx" ON "items"("normalized");

-- CreateIndex
CREATE INDEX "items_type_is_active_idx" ON "items"("type", "is_active");

-- CreateIndex
CREATE INDEX "item_units_item_id_idx" ON "item_units"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_units_item_id_uom_key" ON "item_units"("item_id", "uom");

-- CreateIndex
CREATE INDEX "bom_lines_component_id_idx" ON "bom_lines"("component_id");

-- CreateIndex
CREATE UNIQUE INDEX "bom_lines_bom_revision_id_line_no_key" ON "bom_lines"("bom_revision_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "document_number_ranges_kind_series_year_key" ON "document_number_ranges"("kind", "series", "year");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_document_no_key" ON "deliveries"("document_no");

-- CreateIndex
CREATE INDEX "deliveries_sales_order_id_idx" ON "deliveries"("sales_order_id");

-- CreateIndex
CREATE INDEX "deliveries_partner_id_shipped_at_idx" ON "deliveries"("partner_id", "shipped_at");

-- CreateIndex
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

-- CreateIndex
CREATE INDEX "delivery_lines_item_id_idx" ON "delivery_lines"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_lines_delivery_id_line_no_key" ON "delivery_lines"("delivery_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_document_no_key" ON "sales_invoices"("document_no");

-- CreateIndex
CREATE INDEX "sales_invoices_partner_id_issued_at_idx" ON "sales_invoices"("partner_id", "issued_at");

-- CreateIndex
CREATE INDEX "sales_invoices_sales_order_id_idx" ON "sales_invoices"("sales_order_id");

-- CreateIndex
CREATE INDEX "sales_invoices_status_idx" ON "sales_invoices"("status");

-- CreateIndex
CREATE INDEX "sales_invoices_due_date_idx" ON "sales_invoices"("due_date");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_delivery_id_idx" ON "sales_invoice_lines"("delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoice_lines_invoice_id_line_no_key" ON "sales_invoice_lines"("invoice_id", "line_no");

-- CreateIndex
CREATE INDEX "exchange_rates_currency_quoted_at_idx" ON "exchange_rates"("currency", "quoted_at");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_currency_quoted_at_key" ON "exchange_rates"("currency", "quoted_at");

-- CreateIndex
CREATE UNIQUE INDEX "item_cost_states_item_id_key" ON "item_cost_states"("item_id");

-- CreateIndex
CREATE INDEX "accounting_periods_status_idx" ON "accounting_periods"("status");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_year_month_key" ON "accounting_periods"("year", "month");

-- CreateIndex
CREATE INDEX "batches_status_idx" ON "batches"("status");

-- CreateIndex
CREATE INDEX "batches_expiry_date_idx" ON "batches"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "batches_item_id_batch_no_key" ON "batches"("item_id", "batch_no");

-- CreateIndex
CREATE INDEX "batch_genealogy_output_batch_id_idx" ON "batch_genealogy"("output_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "batch_genealogy_input_batch_id_output_batch_id_work_order_i_key" ON "batch_genealogy"("input_batch_id", "output_batch_id", "work_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_document_no_key" ON "purchase_requisitions"("document_no");

-- CreateIndex
CREATE INDEX "purchase_requisitions_status_idx" ON "purchase_requisitions"("status");

-- CreateIndex
CREATE INDEX "purchase_requisitions_requested_by_idx" ON "purchase_requisitions"("requested_by");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_requisition_id_line_no_key" ON "purchase_requisition_lines"("requisition_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_document_no_key" ON "payments"("document_no");

-- CreateIndex
CREATE INDEX "payments_partner_id_paid_at_idx" ON "payments"("partner_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_direction_idx" ON "payments"("direction");

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_no_idx" ON "payment_allocations"("invoice_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_payment_id_invoice_no_key" ON "payment_allocations"("payment_id", "invoice_no");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_start_date_idx" ON "leave_requests"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE INDEX "leave_adjustments_employee_id_year_idx" ON "leave_adjustments"("employee_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_adjustments_employee_id_year_reason_key" ON "leave_adjustments"("employee_id", "year", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_code_key" ON "shifts"("code");

-- CreateIndex
CREATE INDEX "shift_assignments_work_date_idx" ON "shift_assignments"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_assignments_employee_id_work_date_key" ON "shift_assignments"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "master_data_changes_object_type_object_id_changed_at_idx" ON "master_data_changes"("object_type", "object_id", "changed_at");

-- CreateIndex
CREATE INDEX "master_data_changes_changed_at_idx" ON "master_data_changes"("changed_at");

-- CreateIndex
CREATE INDEX "master_data_changes_changed_by_idx" ON "master_data_changes"("changed_by");

-- CreateIndex
CREATE INDEX "pending_actions_user_id_status_expires_at_idx" ON "pending_actions"("user_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "pending_actions_status_expires_at_idx" ON "pending_actions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_document_no_key" ON "journal_entries"("document_no");

-- CreateIndex
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries"("entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_status_idx" ON "journal_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_source_kind_source_id_key" ON "journal_entries"("source_kind", "source_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_code_entry_id_idx" ON "journal_lines"("account_code", "entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_partner_id_idx" ON "journal_lines"("partner_id");

-- CreateIndex
CREATE INDEX "journal_lines_currency_account_code_idx" ON "journal_lines"("currency", "account_code");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_key" ON "journal_lines"("entry_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_document_no_key" ON "stock_counts"("document_no");

-- CreateIndex
CREATE INDEX "stock_counts_status_idx" ON "stock_counts"("status");

-- CreateIndex
CREATE INDEX "stock_counts_location_id_count_date_idx" ON "stock_counts"("location_id", "count_date");

-- CreateIndex
CREATE INDEX "stock_count_lines_item_id_idx" ON "stock_count_lines"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_lines_count_id_line_no_key" ON "stock_count_lines"("count_id", "line_no");

-- CreateIndex
CREATE INDEX "price_conditions_item_code_is_active_idx" ON "price_conditions"("item_code", "is_active");

-- CreateIndex
CREATE INDEX "price_conditions_partner_id_is_active_idx" ON "price_conditions"("partner_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "sales_quotations_document_no_key" ON "sales_quotations"("document_no");

-- CreateIndex
CREATE INDEX "sales_quotations_partner_id_quoted_at_idx" ON "sales_quotations"("partner_id", "quoted_at");

-- CreateIndex
CREATE INDEX "sales_quotations_status_idx" ON "sales_quotations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_quotation_lines_quotation_id_line_no_key" ON "sales_quotation_lines"("quotation_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_rfqs_document_no_key" ON "purchase_rfqs"("document_no");

-- CreateIndex
CREATE INDEX "purchase_rfqs_status_idx" ON "purchase_rfqs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_quotes_rfq_id_partner_id_key" ON "supplier_quotes"("rfq_id", "partner_id");

-- CreateIndex
CREATE INDEX "maintenance_plans_machine_code_is_active_idx" ON "maintenance_plans"("machine_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_orders_document_no_key" ON "maintenance_orders"("document_no");

-- CreateIndex
CREATE INDEX "maintenance_orders_machine_code_status_idx" ON "maintenance_orders"("machine_code", "status");

-- CreateIndex
CREATE INDEX "maintenance_orders_status_idx" ON "maintenance_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "breakdowns_order_id_key" ON "breakdowns"("order_id");

-- CreateIndex
CREATE INDEX "breakdowns_machine_code_reported_at_idx" ON "breakdowns"("machine_code", "reported_at");

-- CreateIndex
CREATE INDEX "breakdowns_severity_idx" ON "breakdowns"("severity");

-- CreateIndex
CREATE INDEX "serial_numbers_serial_idx" ON "serial_numbers"("serial");

-- CreateIndex
CREATE INDEX "serial_numbers_state_idx" ON "serial_numbers"("state");

-- CreateIndex
CREATE INDEX "serial_numbers_partner_id_idx" ON "serial_numbers"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "serial_numbers_item_id_serial_key" ON "serial_numbers"("item_id", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_code_key" ON "fixed_assets"("code");

-- CreateIndex
CREATE INDEX "fixed_assets_status_idx" ON "fixed_assets"("status");

-- CreateIndex
CREATE INDEX "depreciation_runs_year_idx" ON "depreciation_runs"("year");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_runs_asset_id_year_key" ON "depreciation_runs"("asset_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "sales_credit_notes_document_no_key" ON "sales_credit_notes"("document_no");

-- CreateIndex
CREATE INDEX "sales_credit_notes_partner_id_idx" ON "sales_credit_notes"("partner_id");

-- CreateIndex
CREATE INDEX "sales_credit_notes_invoice_id_idx" ON "sales_credit_notes"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_credit_note_lines_note_id_line_no_key" ON "sales_credit_note_lines"("note_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_period_key" ON "payroll_runs"("period");

-- CreateIndex
CREATE INDEX "payroll_lines_employee_id_idx" ON "payroll_lines"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_period_employee_id_key" ON "payroll_lines"("period", "employee_id");

-- CreateIndex
CREATE INDEX "watches_is_active_idx" ON "watches"("is_active");

-- CreateIndex
CREATE INDEX "watches_owner_user_id_idx" ON "watches"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "watches_owner_user_id_name_key" ON "watches"("owner_user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statements_account_id_statement_no_key" ON "bank_statements"("account_id", "statement_no");

-- CreateIndex
CREATE INDEX "bank_statement_lines_status_value_date_idx" ON "bank_statement_lines"("status", "value_date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_statement_id_line_no_key" ON "bank_statement_lines"("statement_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_line_id_key" ON "reconciliation_matches"("line_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_payment_id_key" ON "reconciliation_matches"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "dunning_levels_level_key" ON "dunning_levels"("level");

-- CreateIndex
CREATE UNIQUE INDEX "dunning_notices_document_no_key" ON "dunning_notices"("document_no");

-- CreateIndex
CREATE INDEX "dunning_notices_partner_id_issued_at_idx" ON "dunning_notices"("partner_id", "issued_at");

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

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "work_centers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_status_snapshots" ADD CONSTRAINT "machine_status_snapshots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_units" ADD CONSTRAINT "item_units_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_revision_id_fkey" FOREIGN KEY ("bom_revision_id") REFERENCES "bom_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_genealogy" ADD CONSTRAINT "batch_genealogy_input_batch_id_fkey" FOREIGN KEY ("input_batch_id") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_genealogy" ADD CONSTRAINT "batch_genealogy_output_batch_id_fkey" FOREIGN KEY ("output_batch_id") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "purchase_requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "sales_quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "purchase_rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_orders" ADD CONSTRAINT "maintenance_orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "maintenance_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breakdowns" ADD CONSTRAINT "breakdowns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "maintenance_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_note_lines" ADD CONSTRAINT "sales_credit_note_lines_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "sales_credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "bank_statement_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

