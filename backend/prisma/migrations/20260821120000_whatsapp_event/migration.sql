-- WhatsApp reporting bot — Phase 2 (ingestion).
-- Inbound webhook messages are stored before processing so the endpoint can
-- acknowledge Meta immediately. `wamid` is unique: a retried delivery collides
-- and is skipped, which is what keeps one message from becoming two reports.

CREATE TABLE "WhatsAppEvent" (
    "id" TEXT NOT NULL,
    "wamid" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppEvent_wamid_key" ON "WhatsAppEvent"("wamid");
CREATE INDEX "WhatsAppEvent_status_createdAt_idx" ON "WhatsAppEvent"("status", "createdAt");
CREATE INDEX "WhatsAppEvent_phoneE164_createdAt_idx" ON "WhatsAppEvent"("phoneE164", "createdAt");
