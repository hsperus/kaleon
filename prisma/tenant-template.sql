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

-- AddForeignKey
ALTER TABLE "partner_aliases" ADD CONSTRAINT "partner_aliases_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_tax_ids" ADD CONSTRAINT "partner_tax_ids_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_external_refs" ADD CONSTRAINT "partner_external_refs_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

