-- LeadNote gets its own organisationId.
--
-- WHY, since it never needed one before: until the previous migration every
-- note hung off exactly one Lead, so tenancy was inherited through a REQUIRED
-- foreign key. `leadId` is now nullable — a note can be about the customer
-- instead — and the destructive go-live operations (purgeDemo,
-- resetSyncedData, resetToHeadOffice) scope such a table by walking its
-- shortest to-one relation to an org-bearing ancestor. That walk now resolves
-- LeadNote to `{ lead: { organisationId } }`, which matches no note whose
-- leadId is null. A purge would therefore leave demo notes attached to real
-- customers, silently.
--
-- Backfill is total, so the NOT NULL below cannot fail: every row that exists
-- when this runs was written while leadId was still mandatory, and
-- Lead.organisationId is itself NOT NULL.

-- 1. The column.
ALTER TABLE "LeadNote" ADD COLUMN "organisationId" TEXT;

-- 2. Backfill through the lead (all existing rows have one), then through the
--    party for anything written between the two migrations.
UPDATE "LeadNote" n
SET "organisationId" = l."organisationId"
FROM "Lead" l
WHERE n."leadId" = l."id" AND n."organisationId" IS NULL;

UPDATE "LeadNote" n
SET "organisationId" = p."organisationId"
FROM "Party" p
WHERE n."partyId" = p."id" AND n."organisationId" IS NULL;

-- 3. A note that belongs to no tenant is not a note anybody can safely read or
--    delete, so the column is mandatory from here on. This table is small and
--    the lock is momentary — unlike the bulk NOT NULL sweep in caratos_org_not_null.
ALTER TABLE "LeadNote" ALTER COLUMN "organisationId" SET NOT NULL;

ALTER TABLE "LeadNote"
  ADD CONSTRAINT "LeadNote_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "LeadNote_organisationId_idx" ON "LeadNote"("organisationId");
