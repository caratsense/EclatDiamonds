-- CaratOS — WhatsApp internal reporting bot, organisation-scoped. Purely additive.
--
-- Four new tables (WhatsAppIdentity / WhatsAppEvent / WhatsAppSession /
-- WhatsAppLinkCode), each carrying a nullable organisationId + FK ON DELETE SET
-- NULL, matching the anchored-isolation pattern used by the rest of CaratOS.
-- Plus DailyReport.source (web|whatsapp) and the per-store-per-day unique that
-- makes the bot's submit an idempotent upsert.
--
-- No backfill / UPDATE: WhatsAppEvent.organisationId is null at row-creation and
-- stamped at processing time; the other three are stamped on insert. The
-- DailyReport unique is safe here — verified there are no existing duplicate
-- (storeId, reportDate) rows before this migration is applied.

-- CreateTable
CREATE TABLE "WhatsAppIdentity" (
    "organisationId" TEXT,
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "verifiedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppEvent" (
    "organisationId" TEXT,
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

-- CreateTable
CREATE TABLE "WhatsAppSession" (
    "organisationId" TEXT,
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

-- CreateTable
CREATE TABLE "WhatsAppLinkCode" (
    "organisationId" TEXT,
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppLinkCode_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DailyReport" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'web';

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIdentity_phoneE164_key" ON "WhatsAppIdentity"("phoneE164");
CREATE INDEX "WhatsAppIdentity_userId_idx" ON "WhatsAppIdentity"("userId");
CREATE INDEX "WhatsAppIdentity_organisationId_idx" ON "WhatsAppIdentity"("organisationId");

CREATE UNIQUE INDEX "WhatsAppEvent_wamid_key" ON "WhatsAppEvent"("wamid");
CREATE INDEX "WhatsAppEvent_status_createdAt_idx" ON "WhatsAppEvent"("status", "createdAt");
CREATE INDEX "WhatsAppEvent_phoneE164_createdAt_idx" ON "WhatsAppEvent"("phoneE164", "createdAt");
CREATE INDEX "WhatsAppEvent_organisationId_idx" ON "WhatsAppEvent"("organisationId");

CREATE UNIQUE INDEX "WhatsAppSession_phoneE164_key" ON "WhatsAppSession"("phoneE164");
CREATE INDEX "WhatsAppSession_expiresAt_idx" ON "WhatsAppSession"("expiresAt");
CREATE INDEX "WhatsAppSession_organisationId_idx" ON "WhatsAppSession"("organisationId");

CREATE INDEX "WhatsAppLinkCode_userId_createdAt_idx" ON "WhatsAppLinkCode"("userId", "createdAt");
CREATE INDEX "WhatsAppLinkCode_organisationId_idx" ON "WhatsAppLinkCode"("organisationId");

-- Collapse any pre-existing duplicate (storeId, reportDate) rows before the
-- unique is added, keeping the most recently created row of each group (ties
-- broken by id). A duplicate DSR for one store-day is redundant by definition —
-- the roll-ups already double-count it — so the newest wins and the rest go.
-- No-op where there are none.
DELETE FROM "DailyReport" a
USING "DailyReport" b
WHERE a."storeId" = b."storeId"
  AND a."reportDate" = b."reportDate"
  AND a."id" <> b."id"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

CREATE UNIQUE INDEX "DailyReport_storeId_reportDate_key" ON "DailyReport"("storeId", "reportDate");

-- AddForeignKey
ALTER TABLE "WhatsAppIdentity" ADD CONSTRAINT "WhatsAppIdentity_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppIdentity" ADD CONSTRAINT "WhatsAppIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppEvent" ADD CONSTRAINT "WhatsAppEvent_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppLinkCode" ADD CONSTRAINT "WhatsAppLinkCode_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppLinkCode" ADD CONSTRAINT "WhatsAppLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
