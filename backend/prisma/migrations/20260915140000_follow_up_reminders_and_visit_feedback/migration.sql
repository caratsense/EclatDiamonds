-- Block 3: a follow-up's reminder, and the automatic feedback ask after a visit.
--
-- LeadFollowUp: who is reminded, when (a real instant in the branch timezone),
-- and the claim that marks it sent. All nullable: existing follow-ups keep
-- working and simply have no reminder.
ALTER TABLE "LeadFollowUp" ADD COLUMN "assigneeId" TEXT;
ALTER TABLE "LeadFollowUp" ADD COLUMN "reminderAt" TIMESTAMP(3);
ALTER TABLE "LeadFollowUp" ADD COLUMN "reminderNotifiedAt" TIMESTAMP(3);
ALTER TABLE "LeadFollowUp" ADD CONSTRAINT "LeadFollowUp_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "LeadFollowUp_done_reminderNotifiedAt_reminderAt_idx" ON "LeadFollowUp"("done", "reminderNotifiedAt", "reminderAt");

-- FeedbackRequest: the scheduled, deduplicated visit ask. Every existing row
-- was created by a person, which is the default origin.
ALTER TABLE "FeedbackRequest" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "FeedbackRequest" ADD COLUMN "scheduledFor" TIMESTAMP(3);
ALTER TABLE "FeedbackRequest" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "FeedbackRequest" ADD COLUMN "deliveryNote" TEXT;
ALTER TABLE "FeedbackRequest" ADD COLUMN "dispatchAttempts" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "FeedbackRequest_dedupeKey_key" ON "FeedbackRequest"("dedupeKey");
CREATE INDEX "FeedbackRequest_status_scheduledFor_idx" ON "FeedbackRequest"("status", "scheduledFor");
