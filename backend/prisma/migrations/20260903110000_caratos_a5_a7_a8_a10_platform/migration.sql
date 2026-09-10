-- CaratOS Phases A5 / A7 / A8 / A10 — integrations, import provenance,
-- background jobs, attribution.
--
-- PURELY ADDITIVE. Six new tables plus nullable columns on Party, Product,
-- Store and MarketingCampaign. No existing column changes type or nullability,
-- so every current query is unaffected.
--
-- The `importBatchId` columns are the ones that matter operationally: without
-- them, purgeDemo's "a row with no legacyId is seeded demo data" rule deletes
-- every CSV-imported customer and product. The column is added here; the guard
-- that reads it is in the Phase B1 change.
--
-- Pre-existing index drift (Handoff_assignedToId_idx, User_approvalStatus_idx)
-- is excluded, as in the two prior CaratOS migrations.



-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN     "externalCampaignId" TEXT,
ADD COLUMN     "provider" TEXT;

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "importBatchId" TEXT;

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_configured',
    "config" JSONB,
    "capabilities" JSONB,
    "lastHealthAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "watermark" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationAsset" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "integrationId" TEXT,
    "providerCode" TEXT NOT NULL,
    "externalId" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTask" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "result" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionTouch" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "partyId" TEXT,
    "leadId" TEXT,
    "channel" TEXT NOT NULL,
    "source" TEXT,
    "medium" TEXT,
    "campaignId" TEXT,
    "externalCampaignId" TEXT,
    "externalAdSetId" TEXT,
    "externalAdId" TEXT,
    "clickId" TEXT,
    "position" TEXT NOT NULL DEFAULT 'mid',
    "evidence" TEXT NOT NULL DEFAULT 'declared',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionTouch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Integration_organisationId_status_idx" ON "Integration"("organisationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organisationId_providerCode_name_key" ON "Integration"("organisationId", "providerCode", "name");

-- CreateIndex
CREATE INDEX "IntegrationCredential_organisationId_idx" ON "IntegrationCredential"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_integrationId_kind_key" ON "IntegrationCredential"("integrationId", "kind");

-- CreateIndex
CREATE INDEX "IntegrationAsset_organisationId_kind_idx" ON "IntegrationAsset"("organisationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAsset_integrationId_kind_externalId_key" ON "IntegrationAsset"("integrationId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_createdAt_idx" ON "WebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_organisationId_createdAt_idx" ON "WebhookEvent"("organisationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerCode_externalId_key" ON "WebhookEvent"("providerCode", "externalId");

-- CreateIndex
CREATE INDEX "JobTask_status_runAt_priority_idx" ON "JobTask"("status", "runAt", "priority");

-- CreateIndex
CREATE INDEX "JobTask_organisationId_kind_status_idx" ON "JobTask"("organisationId", "kind", "status");

-- CreateIndex
CREATE INDEX "JobTask_status_lockedAt_idx" ON "JobTask"("status", "lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobTask_idempotencyKey_key" ON "JobTask"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AttributionTouch_organisationId_partyId_occurredAt_idx" ON "AttributionTouch"("organisationId", "partyId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttributionTouch_organisationId_leadId_occurredAt_idx" ON "AttributionTouch"("organisationId", "leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttributionTouch_organisationId_campaignId_occurredAt_idx" ON "AttributionTouch"("organisationId", "campaignId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttributionTouch_organisationId_evidence_occurredAt_idx" ON "AttributionTouch"("organisationId", "evidence", "occurredAt");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationAsset" ADD CONSTRAINT "IntegrationAsset_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationAsset" ADD CONSTRAINT "IntegrationAsset_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTask" ADD CONSTRAINT "JobTask_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

