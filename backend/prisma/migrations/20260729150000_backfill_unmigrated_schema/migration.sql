-- Catch-up migration for schema applied via `db push` but never captured (2026-07-29).
--
-- Found by diffing a database built purely from the migration chain against
-- `schema.prisma`: five objects existed in the schema and in the live databases
-- but in no migration. They were pushed directly at some point, so every
-- environment that had been pushed to looked fine — while any FRESH environment
-- built with `prisma migrate deploy` would come up missing them, and the code
-- referencing them would fail at runtime.
--
-- Everything here is additive and guarded, so it is a no-op on a database that
-- already has these objects and a repair on one that does not.

-- ---------------------------------------------------------------------------
-- 1. PaymentMode.old_gold — old-gold settlement (Module 14).
--    Its own statement block: Postgres forbids USING an enum label added in the
--    same transaction, and nothing below references it.
-- ---------------------------------------------------------------------------
ALTER TYPE "PaymentMode" ADD VALUE IF NOT EXISTS 'old_gold';

-- ---------------------------------------------------------------------------
-- 2. Additive columns
-- ---------------------------------------------------------------------------
ALTER TABLE "Lead"
  ADD COLUMN IF NOT EXISTS "location" TEXT;

ALTER TABLE "QuoteLine"
  ADD COLUMN IF NOT EXISTS "perCaratRate" DECIMAL(12,2);

ALTER TABLE "ReturnRecord"
  ADD COLUMN IF NOT EXISTS "purchaseDiscountType"  TEXT,
  ADD COLUMN IF NOT EXISTS "purchaseDiscountValue" DECIMAL(14,2);

-- ---------------------------------------------------------------------------
-- 3. DiscountPreset — the seeded preset discount codes (Module 15).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "DiscountPreset" (
    "id"             TEXT NOT NULL,
    "code"           TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "diamondPercent" DECIMAL(5,2),
    "makingPercent"  DECIMAL(5,2),
    "overallPercent" DECIMAL(5,2),
    "description"    TEXT,
    "isActive"       BOOLEAN NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountPreset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DiscountPreset_code_key" ON "DiscountPreset"("code");
