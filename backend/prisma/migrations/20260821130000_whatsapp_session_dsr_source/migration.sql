-- WhatsApp reporting bot — Phase 3 (guided conversation).
--
-- 1. WhatsAppSession: a daily report is ten questions, so answers accumulate in
--    `draft` until the user confirms. One live session per number.
-- 2. DailyReport.source: tells a bot submission from a web one.
-- 3. DailyReport unique (storeId, reportDate): a resubmission or a webhook retry
--    must UPDATE the day, not add a second row that doubles every roll-up.
--    Verified no duplicate (storeId, reportDate) rows exist before adding it.

CREATE TABLE "WhatsAppSession" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT,
    "flow" TEXT NOT NULL DEFAULT 'idle',
    "step" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB,
    "storeId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppSession_phoneE164_key" ON "WhatsAppSession"("phoneE164");
CREATE INDEX "WhatsAppSession_expiresAt_idx" ON "WhatsAppSession"("expiresAt");

ALTER TABLE "DailyReport" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'web';

CREATE UNIQUE INDEX "DailyReport_storeId_reportDate_key" ON "DailyReport"("storeId", "reportDate");
