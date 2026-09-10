-- Customer feedback, and the boundary between an internal complaint and a
-- public review.
--
-- Purely additive: one new table. Rollback is DROP TABLE "FeedbackRequest".
--
-- WHY publicKey IS GLOBALLY UNIQUE: the response page is anonymous and resolves
-- the tenant FROM this value with no organisation in hand. A key that could
-- repeat across tenants would let one tenant's link write a rating into
-- another's CRM. The unique index is the enforcement; the generator is not.
--
-- WHY reviewLinkOffered IS STORED: a tenant needs to be able to show that it
-- never invited an unhappy customer to leave a public review. A boolean derived
-- at read time from today's threshold would rewrite history every time the
-- threshold changed.

CREATE TABLE "FeedbackRequest" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT,
    "partyId" TEXT,
    "checkInId" TEXT,
    "saleId" TEXT,
    "taskId" TEXT,
    "publicKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "rating" INTEGER,
    "comment" TEXT,
    "escalatedTaskId" TEXT,
    "reviewLinkOffered" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedbackRequest_publicKey_key" ON "FeedbackRequest"("publicKey");
CREATE INDEX "FeedbackRequest_organisationId_status_createdAt_idx"
    ON "FeedbackRequest"("organisationId", "status", "createdAt");
CREATE INDEX "FeedbackRequest_organisationId_storeId_respondedAt_idx"
    ON "FeedbackRequest"("organisationId", "storeId", "respondedAt");
CREATE INDEX "FeedbackRequest_organisationId_partyId_idx"
    ON "FeedbackRequest"("organisationId", "partyId");

ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL: deleting a customer record must not delete the fact that feedback
-- was collected, which a branch's score is computed from.
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
