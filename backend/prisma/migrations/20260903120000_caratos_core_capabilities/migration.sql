-- CaratOS core capabilities (Phase A9/A10/A14 + CRM task gaps).
--
-- ADDITIVE ONLY. Every column added is nullable or carries a default, every
-- table is new, and no existing row is rewritten or removed. This migration can
-- run against a live database with traffic on it.
--
-- Written by hand rather than generated: `prisma migrate dev` wanted to drop two
-- indexes that exist in the deployed database but not in the schema history
-- (Handoff_assignedToId_idx, User_approvalStatus_idx). Those are pre-existing
-- drift, unrelated to this change, and dropping them here would smuggle an
-- unrelated production change into a feature migration.

-- ---------------------------------------------------------------- Task gaps
-- `assignee` (a display name) is KEPT. Historical tasks have nothing else, and
-- a name is not an identity to backfill from -- guessing which user a name meant
-- would silently reassign someone's work.
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "assigneeId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "partyId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "leadId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- ON DELETE SET NULL, not CASCADE: deleting a customer must not silently delete
-- the record that someone still owed work on them.
DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Task_organisationId_assigneeId_status_idx"
  ON "Task"("organisationId", "assigneeId", "status");
CREATE INDEX IF NOT EXISTS "Task_organisationId_partyId_idx" ON "Task"("organisationId", "partyId");
CREATE INDEX IF NOT EXISTS "Task_organisationId_leadId_idx" ON "Task"("organisationId", "leadId");

-- ------------------------------------------------- Attribution: revenue link
ALTER TABLE "AttributionTouch" ADD COLUMN IF NOT EXISTS "saleId" TEXT;
ALTER TABLE "AttributionTouch" ADD COLUMN IF NOT EXISTS "creditModel" TEXT;

DO $$ BEGIN
  ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_saleId_fkey"
    FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "AttributionTouch_organisationId_saleId_idx"
  ON "AttributionTouch"("organisationId", "saleId");

-- ---------------------------------------------- Payment reference lookup
-- An INDEX, not a unique constraint, and not an idempotency mechanism.
--
-- `Payment.reference` is the PAYER'S NAME (see payment.dto.ts) — free text for an
-- unlinked walk-in collection, rendered as the customer name on the ledger. It is
-- not a bank/UTR transaction id, so it cannot carry a uniqueness guarantee: two
-- genuine cash collections from the same person on the same day are ordinary.
--
-- The index exists because the ledger looks payments up by that name. Real
-- payment idempotency needs a field that identifies a transaction, which does
-- not exist yet and is recorded as follow-up work.
CREATE INDEX IF NOT EXISTS "Payment_organisationId_reference_idx"
  ON "Payment"("organisationId", "reference");

-- ------------------------------------------------- CRM AI qualification (A9)
CREATE TABLE IF NOT EXISTS "LeadQualification" (
  "id"                 TEXT NOT NULL,
  "organisationId"     TEXT NOT NULL,
  "partyId"            TEXT,
  "leadId"             TEXT,
  "conversationId"     TEXT,
  "method"             TEXT NOT NULL DEFAULT 'rules',
  "score"              INTEGER,
  "confidence"         DECIMAL(4,3),
  "band"               TEXT,
  "recommendedAction"  TEXT,
  "handoffRequested"   BOOLEAN NOT NULL DEFAULT false,
  "handoffReason"      TEXT,
  "signals"            JSONB,
  "requirements"       JSONB,
  "summary"            TEXT,
  "policyVersion"      INTEGER NOT NULL DEFAULT 1,
  "provider"           TEXT,
  "model"              TEXT,
  "unavailableReason"  TEXT,
  "messagesConsidered" INTEGER NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"        TEXT,
  CONSTRAINT "LeadQualification_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "LeadQualification" ADD CONSTRAINT "LeadQualification_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LeadQualification" ADD CONSTRAINT "LeadQualification_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LeadQualification" ADD CONSTRAINT "LeadQualification_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LeadQualification" ADD CONSTRAINT "LeadQualification_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "LeadQualification_organisationId_partyId_createdAt_idx"
  ON "LeadQualification"("organisationId", "partyId", "createdAt");
CREATE INDEX IF NOT EXISTS "LeadQualification_organisationId_leadId_createdAt_idx"
  ON "LeadQualification"("organisationId", "leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "LeadQualification_organisationId_conversationId_createdAt_idx"
  ON "LeadQualification"("organisationId", "conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "LeadQualification_organisationId_band_createdAt_idx"
  ON "LeadQualification"("organisationId", "band", "createdAt");

-- --------------------------------------------------- CaratOS Connect (A14)
-- The agent's identity. `tokenHash` is unique and is the ONLY thing stored: the
-- plaintext is shown once at enrolment, so a database leak cannot be replayed as
-- an agent.
CREATE TABLE IF NOT EXISTS "ConnectAgent" (
  "id"             TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "storeId"        TEXT,
  "sourceSystem"   TEXT NOT NULL,
  "tokenHash"      TEXT NOT NULL,
  "tokenPrefix"    TEXT NOT NULL,
  "revokedAt"      TIMESTAMP(3),
  "revokedById"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'enrolled',
  "agentVersion"   TEXT,
  "hostname"       TEXT,
  "os"             TEXT,
  "lastSeenAt"     TIMESTAMP(3),
  "lastSyncAt"     TIMESTAMP(3),
  "lastError"      TEXT,
  "lastStats"      JSONB,
  "config"         JSONB,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No DB-level default: Prisma's @updatedAt sets this on every write, and a
  -- default here shows up forever as schema drift against the datamodel.
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectAgent_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ConnectAgent" ADD CONSTRAINT "ConnectAgent_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ConnectAgent" ADD CONSTRAINT "ConnectAgent_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ConnectAgent_tokenHash_key" ON "ConnectAgent"("tokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "ConnectAgent_organisationId_name_key"
  ON "ConnectAgent"("organisationId", "name");
CREATE INDEX IF NOT EXISTS "ConnectAgent_organisationId_status_idx"
  ON "ConnectAgent"("organisationId", "status");
CREATE INDEX IF NOT EXISTS "ConnectAgent_organisationId_sourceSystem_idx"
  ON "ConnectAgent"("organisationId", "sourceSystem");
