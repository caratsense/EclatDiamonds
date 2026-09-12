-- What was decided when the customer left.
--
-- The meeting asked for a follow-up date, a reminder and a remark "in the
-- check-in section". Until now a visit could record that somebody came in and
-- what they looked at, but not what to do next — so the floor wrote it on paper
-- and the CRM never learned about it.
--
-- `remark` and `followUpDate` are two columns on purpose. The participants
-- argued about whether a remark implies an action and stopped without agreeing
-- (12:03-14:52 in the transcript). The reading taken here is the one where they
-- do not overlap: the remark is what was SAID, the date is what will be DONE,
-- and either may exist without the other. If the client later decides a remark
-- must always imply an action, that is a UI rule, not a second migration.
--
-- All nullable, nothing backfilled. A visit recorded before today genuinely had
-- no follow-up decision attached, and inventing one would manufacture the very
-- record this column exists to capture honestly.

ALTER TABLE "CheckIn" ADD COLUMN "remark" TEXT;

-- A DATE, not a timestamp. "Call them Tuesday" is a calendar day in the store's
-- own timezone; as an instant it becomes a different day for anyone reading from
-- another zone, which is how a follow-up quietly lands in yesterday's queue.
ALTER TABLE "CheckIn" ADD COLUMN "followUpDate" DATE;

ALTER TABLE "CheckIn" ADD COLUMN "followUpOwnerId" TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "preferredAction" TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "leadId" TEXT;

-- Finding today's outstanding visit follow-ups for one branch is the query the
-- morning digest runs, so it gets an index rather than a scan of every visit
-- ever recorded.
CREATE INDEX "CheckIn_storeId_followUpDate_idx" ON "CheckIn"("storeId", "followUpDate");
CREATE INDEX "CheckIn_followUpOwnerId_followUpDate_idx" ON "CheckIn"("followUpOwnerId", "followUpDate");
CREATE INDEX "CheckIn_leadId_idx" ON "CheckIn"("leadId");

-- SET NULL on both, never CASCADE.
--
-- Deleting a user must not delete the record that a customer visited, and losing
-- the enquiry must not delete the visit either. The visit is the fact; the owner
-- and the enquiry are attachments to it.
ALTER TABLE "CheckIn"
    ADD CONSTRAINT "CheckIn_followUpOwnerId_fkey"
    FOREIGN KEY ("followUpOwnerId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CheckIn"
    ADD CONSTRAINT "CheckIn_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
