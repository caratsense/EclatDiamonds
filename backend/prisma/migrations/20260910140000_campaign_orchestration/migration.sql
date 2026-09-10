-- Campaign orchestration: saved audiences, sending campaigns, per-recipient rows.
--
-- Purely additive: one new enum and three new tables. Nothing existing gains,
-- loses or changes a column, so every row already in this database stays valid
-- and rollback is three DROP TABLEs plus DROP TYPE, in that order.
--
-- Deliberately NOT folded into "MarketingCampaign". That table plans agency work
-- and its "CampaignType" enum is jewellery vocabulary (bridal, festive); a
-- hospital's appointment reminder must not have to claim it is a bridal
-- campaign to be sent. The two are linked by a nullable id, not by a shared row.
--
-- The one constraint that carries real weight is
-- "CampaignRecipient_campaignId_contactValue_key". Expansion is a background
-- job, and background jobs are retried; that unique index is what turns a
-- second expansion into a lost race instead of a second message to the same
-- person. It is on the NORMALIZED contact value for the same reason identity
-- matching is: "+91 98765 43210" and "919876543210" are one person.

CREATE TYPE "MessagingCampaignStatus" AS ENUM (
    'draft',
    'awaiting_approval',
    'approved',
    'scheduled',
    'expanding',
    'queued',
    'sending',
    'completed',
    'partially_failed',
    'cancelled',
    'failed'
);

CREATE TABLE "AudienceSegment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceSegment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AudienceSegment_organisationId_name_key"
    ON "AudienceSegment"("organisationId", "name");
CREATE INDEX "AudienceSegment_organisationId_updatedAt_idx"
    ON "AudienceSegment"("organisationId", "updatedAt");

CREATE TABLE "MessagingCampaign" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "status" "MessagingCampaignStatus" NOT NULL DEFAULT 'draft',
    "segmentId" TEXT,
    "audienceSnapshot" JSONB,
    "templateName" TEXT,
    "templateLanguage" TEXT,
    "templateAssetId" TEXT,
    "bodyPreview" TEXT,
    "storeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "providerSnapshot" JSONB,
    "marketingCampaignId" TEXT,
    "expandedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessagingCampaign_organisationId_status_scheduledAt_idx"
    ON "MessagingCampaign"("organisationId", "status", "scheduledAt");
CREATE INDEX "MessagingCampaign_organisationId_createdAt_idx"
    ON "MessagingCampaign"("organisationId", "createdAt");

CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "partyId" TEXT,
    "contactValue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "exclusionReason" TEXT,
    "messageId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignRecipient_campaignId_contactValue_key"
    ON "CampaignRecipient"("campaignId", "contactValue");
CREATE INDEX "CampaignRecipient_organisationId_campaignId_status_idx"
    ON "CampaignRecipient"("organisationId", "campaignId", "status");
CREATE INDEX "CampaignRecipient_messageId_idx"
    ON "CampaignRecipient"("messageId");

ALTER TABLE "AudienceSegment" ADD CONSTRAINT "AudienceSegment_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessagingCampaign" ADD CONSTRAINT "MessagingCampaign_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL, not CASCADE: deleting a saved segment must not delete the record of
-- campaigns that ran from it. Their frozen audienceSnapshot is what they were
-- actually sent to anyway.
ALTER TABLE "MessagingCampaign" ADD CONSTRAINT "MessagingCampaign_segmentId_fkey"
    FOREIGN KEY ("segmentId") REFERENCES "AudienceSegment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "MessagingCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
