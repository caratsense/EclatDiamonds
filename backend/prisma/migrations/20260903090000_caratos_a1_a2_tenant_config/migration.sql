-- CaratOS Phase A1 + A2 — tenant lifecycle + universal configuration layer.
--
-- Hand-written rather than `migrate dev` output for two reasons:
--   1. The generated script dropped Organisation.isActive BEFORE anything read
--      it, silently losing which tenants were disabled. The backfill below runs
--      first, so `status` inherits the old flag's meaning.
--   2. The diff also wanted to drop Handoff_assignedToId_idx and
--      User_approvalStatus_idx. Those are pre-existing drift (indexes present in
--      the database but absent from schema.prisma), unrelated to this change,
--      and dropping them here would quietly deoptimise two live queries. They
--      are deliberately left in place.
--
-- Additive and reversible in effect: every new column is nullable or defaulted,
-- and no existing row changes meaning.

-- ---------------------------------------------------------------------------
-- A1: tenant lifecycle + regional defaults
-- ---------------------------------------------------------------------------
CREATE TYPE "OrganisationStatus" AS ENUM ('onboarding', 'active', 'suspended', 'cancelled');

ALTER TABLE "Organisation"
  ADD COLUMN "status"              "OrganisationStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "industryPackCode"    TEXT,
  ADD COLUMN "industryPackVersion" INTEGER,
  ADD COLUMN "country"             TEXT    NOT NULL DEFAULT 'IN',
  ADD COLUMN "currency"            TEXT    NOT NULL DEFAULT 'INR',
  ADD COLUMN "timezone"            TEXT    NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN "settings"            JSONB,
  ADD COLUMN "configVersion"       INTEGER NOT NULL DEFAULT 1;

-- Preserve the old flag's meaning BEFORE the column goes away. A tenant that was
-- switched off stays switched off; 'suspended' is the reversible state, never
-- 'cancelled'.
UPDATE "Organisation" SET "status" = 'suspended' WHERE "isActive" = false;

-- Eclat (organisation #1) is the jewellery tenant. Recorded rather than assumed,
-- so ConfigService never has to infer an industry from the data.
UPDATE "Organisation" SET "industryPackCode" = 'jewellery' WHERE "industryPackCode" IS NULL;

ALTER TABLE "Organisation" DROP COLUMN "isActive";

-- ---------------------------------------------------------------------------
-- A2: tenant-defined attribute VALUES (JSONB on the entity, not EAV)
-- ---------------------------------------------------------------------------
ALTER TABLE "Product" ADD COLUMN "attributes" JSONB;
ALTER TABLE "Party"   ADD COLUMN "attributes" JSONB;
ALTER TABLE "Lead"    ADD COLUMN "attributes" JSONB;

-- ---------------------------------------------------------------------------
-- A2: configuration definitions
-- ---------------------------------------------------------------------------
CREATE TABLE "TaxonomyTerm" (
    "id"             TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind"           TEXT NOT NULL,
    "code"           TEXT NOT NULL,
    "label"          TEXT NOT NULL,
    "parentId"       TEXT,
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "isActive"       BOOLEAN NOT NULL DEFAULT true,
    "packCode"       TEXT,
    "systemValue"    TEXT,
    "metadata"       JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxonomyTerm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttributeDefinition" (
    "id"             TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "entity"         TEXT NOT NULL,
    "key"            TEXT NOT NULL,
    "label"          TEXT NOT NULL,
    "dataType"       TEXT NOT NULL,
    "required"       BOOLEAN NOT NULL DEFAULT false,
    "taxonomyKind"   TEXT,
    "options"        JSONB,
    "unit"           TEXT,
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "isActive"       BOOLEAN NOT NULL DEFAULT true,
    "searchable"     BOOLEAN NOT NULL DEFAULT false,
    "packCode"       TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttributeDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FieldPolicy" (
    "id"             TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "entity"         TEXT NOT NULL,
    "field"          TEXT NOT NULL,
    "requirement"    TEXT NOT NULL DEFAULT 'optional',
    "label"          TEXT,
    "ownership"      TEXT NOT NULL DEFAULT 'UNKNOWN',
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "packCode"       TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FieldPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaxonomyTerm_organisationId_kind_isActive_idx" ON "TaxonomyTerm"("organisationId", "kind", "isActive");
CREATE UNIQUE INDEX "TaxonomyTerm_organisationId_kind_code_key" ON "TaxonomyTerm"("organisationId", "kind", "code");
CREATE INDEX "AttributeDefinition_organisationId_entity_isActive_idx" ON "AttributeDefinition"("organisationId", "entity", "isActive");
CREATE UNIQUE INDEX "AttributeDefinition_organisationId_entity_key_key" ON "AttributeDefinition"("organisationId", "entity", "key");
CREATE INDEX "FieldPolicy_organisationId_entity_idx" ON "FieldPolicy"("organisationId", "entity");
CREATE UNIQUE INDEX "FieldPolicy_organisationId_entity_field_key" ON "FieldPolicy"("organisationId", "entity", "field");

ALTER TABLE "TaxonomyTerm"        ADD CONSTRAINT "TaxonomyTerm_organisationId_fkey"        FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxonomyTerm"        ADD CONSTRAINT "TaxonomyTerm_parentId_fkey"              FOREIGN KEY ("parentId")       REFERENCES "TaxonomyTerm"("id")  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FieldPolicy"         ADD CONSTRAINT "FieldPolicy_organisationId_fkey"         FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
