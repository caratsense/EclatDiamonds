-- Telephony call logs.
--
-- Purely additive: one new table, nothing existing altered. Rollback is
-- DROP TABLE "CallLog".
--
-- Provider-neutral by construction. No column names Exotel or Tata Tele; the
-- webhook that writes these rows normalises whatever arrived, so a second
-- provider needs a mapping, not a migration.
--
-- The unique index on (organisationId, provider, providerCallId) is the one
-- constraint doing real work. Telephony providers retry webhooks for hours, and
-- without it one call would appear three times in an agent's report and in every
-- figure computed from it. Tenant-scoped rather than global because two tenants'
-- providers can legitimately issue the same call id.
--
-- RECORDINGS ARE REFERENCED, NOT COPIED: recordingUrl is the provider's own URL
-- and recordingExpiresAt is when it stops working. Copying the audio here would
-- mean holding customer call recordings under a retention policy nobody has
-- agreed and in a jurisdiction nobody has chosen.

CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT,
    "taskId" TEXT,
    "partyId" TEXT,
    "leadId" TEXT,
    "conversationId" TEXT,
    "direction" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerCallId" TEXT,
    "agentUserId" TEXT,
    "fromNumber" TEXT,
    "toNumber" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "disposition" TEXT,
    "notes" TEXT,
    "recordingUrl" TEXT,
    "recordingExpiresAt" TIMESTAMP(3),
    "transcript" TEXT,
    "transcriptSource" TEXT,
    "summary" TEXT,
    "summarySource" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallLog_organisationId_provider_providerCallId_key"
    ON "CallLog"("organisationId", "provider", "providerCallId");
CREATE INDEX "CallLog_organisationId_startedAt_idx"
    ON "CallLog"("organisationId", "startedAt");
CREATE INDEX "CallLog_organisationId_taskId_idx"
    ON "CallLog"("organisationId", "taskId");
CREATE INDEX "CallLog_organisationId_partyId_startedAt_idx"
    ON "CallLog"("organisationId", "partyId", "startedAt");

ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL throughout: deleting a task, a customer record or a lead must not
-- delete the evidence that a call happened.
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_agentUserId_fkey"
    FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
