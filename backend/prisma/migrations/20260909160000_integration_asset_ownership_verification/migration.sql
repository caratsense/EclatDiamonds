-- Ownership verification for integration assets.
--
-- An IntegrationAsset row has until now meant only "somebody typed this id into
-- a form". These columns record whether the tenant's credential can actually
-- READ that Page, form, ad account or phone number, so an administration screen
-- can stop presenting a manually entered id as a verified connection.
--
-- Additive and forward-only. No backfill: every existing asset starts
-- unverified, which is the truthful default — none has ever been checked.
ALTER TABLE "IntegrationAsset"
  ADD COLUMN IF NOT EXISTS "providerOwnershipVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastError" TEXT;
