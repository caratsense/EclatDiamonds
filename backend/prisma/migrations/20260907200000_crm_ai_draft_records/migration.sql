-- Phase 2C: provenance for AI-drafted replies.
--
-- ADDITIVE ONLY. One new table; no existing column is altered, dropped or
-- re-typed, so there is nothing to backfill and no existing query can change
-- behaviour.

CREATE TABLE "AiDraftRecord" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "latencyMs" INTEGER,
    "policyVersion" TEXT NOT NULL,
    "knowledgeDocumentIds" TEXT[],
    "review" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDraftRecord_pkey" PRIMARY KEY ("id")
);

-- One provenance row per drafted message.
CREATE UNIQUE INDEX "AiDraftRecord_messageId_key" ON "AiDraftRecord"("messageId");

-- The review queue: "what is still pending for this tenant, newest first".
CREATE INDEX "AiDraftRecord_organisationId_review_createdAt_idx"
    ON "AiDraftRecord"("organisationId", "review", "createdAt");

CREATE INDEX "AiDraftRecord_conversationId_idx" ON "AiDraftRecord"("conversationId");

-- RESTRICT: a tenant carrying AI history is not silently deletable.
ALTER TABLE "AiDraftRecord" ADD CONSTRAINT "AiDraftRecord_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE: this row is provenance FOR that message and has no meaning without it.
ALTER TABLE "AiDraftRecord" ADD CONSTRAINT "AiDraftRecord_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL: deactivating an employee must never delete the record of a decision
-- they made. The review outcome survives the reviewer.
ALTER TABLE "AiDraftRecord" ADD CONSTRAINT "AiDraftRecord_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
