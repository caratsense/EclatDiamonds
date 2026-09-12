-- Archive a contact instead of deleting one.
--
-- The meeting opened with "I can't delete a contact — those people blocked us".
-- Deleting is the one thing this must not do, and the reason is not
-- sentimentality about data.
--
-- A person who sent STOP is remembered BY this row. The consent events, the
-- opt-out, `isBlacklisted` and the delivery history all hang off it. Delete the
-- row and the next inbound message from that number resolves to a brand-new
-- customer carrying no opt-out at all — and the system cheerfully messages
-- somebody who explicitly told it to stop. That is a regulatory problem wearing
-- the costume of a housekeeping feature.
--
-- So: archiving HIDES. It removes the contact from directories, search,
-- in-store lookup and campaign audiences. Identity resolution deliberately keeps
-- finding archived rows, because that is what keeps the refusal attached to the
-- person rather than to a record somebody tidied away.
--
-- Additive and nullable. Nothing is backfilled: every existing contact is
-- active, which is what a NULL archivedAt already means.

ALTER TABLE "Party" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Party" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "Party" ADD COLUMN "archiveReason" TEXT;

-- Every active-customer read filters on `archivedAt IS NULL` within a tenant,
-- so the index carries the organisation first and the flag second.
CREATE INDEX "Party_organisationId_archivedAt_idx" ON "Party"("organisationId", "archivedAt");

-- SET NULL: removing a staff member must not remove the record that a contact
-- was archived, only the name of who did it. The reason and the timestamp are
-- the parts that matter for an audit later.
ALTER TABLE "Party"
    ADD CONSTRAINT "Party_archivedById_fkey"
    FOREIGN KEY ("archivedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
