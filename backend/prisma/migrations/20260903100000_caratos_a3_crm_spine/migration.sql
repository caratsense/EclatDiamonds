-- CaratOS Phase A3 — CRM identity spine, timeline, conversations, pipelines.
--
-- PURELY ADDITIVE: seven new tables and their indexes/foreign keys. No existing
-- column is altered or dropped, so every current Eclat query behaves identically
-- before and after. Nothing writes to these tables until the services that own
-- them are wired up, which means applying this migration alone changes no
-- observable behaviour.
--
-- The two DROP INDEX statements Prisma's diff wanted (Handoff_assignedToId_idx,
-- User_approvalStatus_idx) are pre-existing drift unrelated to this change and
-- are deliberately excluded — see 20260903090000 for the same note.



-- CreateTable
CREATE TABLE "ContactPoint" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueNormalized" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeCandidate" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "primaryPartyId" TEXT NOT NULL,
    "duplicatePartyId" TEXT,
    "matchKind" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reason" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT,
    "partyId" TEXT,
    "leadId" TEXT,
    "actorUserId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "channel" TEXT,
    "sourceSystem" TEXT,
    "dedupeKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT,
    "partyId" TEXT,
    "channel" TEXT NOT NULL,
    "integrationId" TEXT,
    "externalThreadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handling" TEXT NOT NULL DEFAULT 'unassigned',
    "assignedUserId" TEXT,
    "subject" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "handoffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "entity" TEXT NOT NULL DEFAULT 'lead',
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL DEFAULT 'open',
    "systemValue" TEXT,
    "probability" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductInteraction" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT,
    "partyId" TEXT,
    "leadId" TEXT,
    "productId" TEXT,
    "sku" TEXT,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "channel" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity" INTEGER,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactPoint_organisationId_partyId_idx" ON "ContactPoint"("organisationId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPoint_organisationId_kind_valueNormalized_key" ON "ContactPoint"("organisationId", "kind", "valueNormalized");

-- CreateIndex
CREATE INDEX "MergeCandidate_organisationId_status_createdAt_idx" ON "MergeCandidate"("organisationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MergeCandidate_organisationId_primaryPartyId_idx" ON "MergeCandidate"("organisationId", "primaryPartyId");

-- CreateIndex
CREATE INDEX "ActivityEvent_organisationId_partyId_occurredAt_idx" ON "ActivityEvent"("organisationId", "partyId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_organisationId_occurredAt_idx" ON "ActivityEvent"("organisationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_organisationId_type_occurredAt_idx" ON "ActivityEvent"("organisationId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_organisationId_leadId_occurredAt_idx" ON "ActivityEvent"("organisationId", "leadId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_organisationId_dedupeKey_key" ON "ActivityEvent"("organisationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Conversation_organisationId_status_lastMessageAt_idx" ON "Conversation"("organisationId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_organisationId_partyId_lastMessageAt_idx" ON "Conversation"("organisationId", "partyId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_organisationId_assignedUserId_status_idx" ON "Conversation"("organisationId", "assignedUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_organisationId_channel_externalThreadId_key" ON "Conversation"("organisationId", "channel", "externalThreadId");

-- CreateIndex
CREATE INDEX "Message_conversationId_sentAt_idx" ON "Message"("conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "Message_organisationId_sentAt_idx" ON "Message"("organisationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_organisationId_externalId_key" ON "Message"("organisationId", "externalId");

-- CreateIndex
CREATE INDEX "Pipeline_organisationId_entity_isActive_idx" ON "Pipeline"("organisationId", "entity", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_organisationId_code_key" ON "Pipeline"("organisationId", "code");

-- CreateIndex
CREATE INDEX "PipelineStage_organisationId_pipelineId_sortOrder_idx" ON "PipelineStage"("organisationId", "pipelineId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_pipelineId_code_key" ON "PipelineStage"("pipelineId", "code");

-- CreateIndex
CREATE INDEX "ProductInteraction_organisationId_partyId_occurredAt_idx" ON "ProductInteraction"("organisationId", "partyId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductInteraction_organisationId_productId_kind_idx" ON "ProductInteraction"("organisationId", "productId", "kind");

-- CreateIndex
CREATE INDEX "ProductInteraction_organisationId_leadId_occurredAt_idx" ON "ProductInteraction"("organisationId", "leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductInteraction_organisationId_storeId_occurredAt_idx" ON "ProductInteraction"("organisationId", "storeId", "occurredAt");

-- AddForeignKey
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeCandidate" ADD CONSTRAINT "MergeCandidate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeCandidate" ADD CONSTRAINT "MergeCandidate_primaryPartyId_fkey" FOREIGN KEY ("primaryPartyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeCandidate" ADD CONSTRAINT "MergeCandidate_duplicatePartyId_fkey" FOREIGN KEY ("duplicatePartyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInteraction" ADD CONSTRAINT "ProductInteraction_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInteraction" ADD CONSTRAINT "ProductInteraction_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInteraction" ADD CONSTRAINT "ProductInteraction_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInteraction" ADD CONSTRAINT "ProductInteraction_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInteraction" ADD CONSTRAINT "ProductInteraction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductInteraction" ADD CONSTRAINT "ProductInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

