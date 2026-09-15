-- The loyalty announcement delivery log.
--
-- Announcements to a tenant's website used to be posted inline after a points
-- movement and retried by a five-minute sweep with no backoff and no dead state.
-- The only trace was three columns on the ledger entry: whether it landed, how
-- many tries, the last error. Nobody could see what the website answered, when
-- the next try was, or re-send one that had given up.
--
-- Each announcement is now a row here, delivered through the durable job queue
-- (retry, backoff, dead). The row keeps the response code, a redacted error, the
-- next retry, timestamps, and a SHA-256 of the exact bytes sent — never the body
-- and never the signing secret.
--
-- One row per (tenant, entry, event): a replayed movement finds the existing row
-- instead of queuing a second announcement.
--
-- All additive. Entries already waiting to be announced are queued by the sweep.

CREATE TABLE "LoyaltyWebhookDelivery" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "destination" TEXT,
    -- 'pending' | 'delivered' | 'failed' | 'dead'
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseCode" INTEGER,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "payloadSha256" TEXT,
    "jobId" TEXT,
    "attemptLog" JSONB,
    "manualRetries" INTEGER NOT NULL DEFAULT 0,
    "lastRetriedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoyaltyWebhookDelivery_organisationId_entryId_eventType_key"
    ON "LoyaltyWebhookDelivery"("organisationId", "entryId", "eventType");
CREATE INDEX "LoyaltyWebhookDelivery_organisationId_status_createdAt_idx"
    ON "LoyaltyWebhookDelivery"("organisationId", "status", "createdAt");

ALTER TABLE "LoyaltyWebhookDelivery"
    ADD CONSTRAINT "LoyaltyWebhookDelivery_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE: an announcement of a movement means nothing once the movement is gone.
ALTER TABLE "LoyaltyWebhookDelivery"
    ADD CONSTRAINT "LoyaltyWebhookDelivery_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "LoyaltyLedgerEntry"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
