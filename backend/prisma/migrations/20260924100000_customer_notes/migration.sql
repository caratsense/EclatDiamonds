-- Notes about a CUSTOMER, not only about a lead.
--
-- Additive and reversible in effect: every existing row keeps its leadId and
-- gains a partyId derived from that lead, so nothing that reads by leadId
-- changes behaviour.
--
-- Order matters here. The column is added and backfilled BEFORE leadId is
-- widened, so that at no point is there a row with neither key set.

-- 1. The new key.
ALTER TABLE "LeadNote" ADD COLUMN "partyId" TEXT;

-- 2. Backfill from the note's own lead, so a customer's notes list is complete
--    from the moment this ships rather than only for notes written afterwards.
--    Lead.partyId is itself nullable — a lead with no identity yet leaves the
--    note's partyId null, which is correct and is why no NOT NULL follows.
UPDATE "LeadNote" n
SET "partyId" = l."partyId"
FROM "Lead" l
WHERE n."leadId" = l."id"
  AND l."partyId" IS NOT NULL;

-- 3. A note about a person belongs to no opportunity.
ALTER TABLE "LeadNote" ALTER COLUMN "leadId" DROP NOT NULL;

-- 4. Cascade with the customer, matching the existing lead behaviour: deleting
--    a customer must not leave their notes behind as orphans.
ALTER TABLE "LeadNote"
  ADD CONSTRAINT "LeadNote_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. The read path is "this customer's notes, newest first".
CREATE INDEX "LeadNote_partyId_createdAt_idx" ON "LeadNote"("partyId", "createdAt");
