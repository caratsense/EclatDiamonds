-- The morning call list.
--
-- From the meeting: "subah subah WhatsApp pe reminder bhej do — aaj in logon se
-- baat karni hai", with tap-to-message and tap-to-call so the staff member does
-- not have to open the app first.
--
-- Two tables, because the settings and the evidence are different things. The
-- settings say when and whether; the run rows say what actually happened to each
-- person on each day, including the reason a message was NOT sent. That reason
-- is the part teams always end up asking for and never have.

CREATE TABLE "StaffDigestSettings" (
    "organisationId" TEXT NOT NULL,
    -- Off by default. A system that starts messaging a client's staff the moment
    -- it is deployed is a system nobody trusts again.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    -- 0-23, read in each STORE's timezone rather than the tenant's, so a chain
    -- across two zones gets it at nine where they are.
    "sendHourLocal" INTEGER NOT NULL DEFAULT 9,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    -- Meta requires an approved template for a business-initiated message. With
    -- none named, the WhatsApp half is skipped and says so rather than falling
    -- back to free text, which Meta refuses anyway.
    "templateName" TEXT,
    "templateLanguage" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffDigestSettings_pkey" PRIMARY KEY ("organisationId")
);

CREATE TABLE "StaffDigestRun" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT,
    "businessDate" DATE NOT NULL,
    "dueCount" INTEGER NOT NULL DEFAULT 0,
    "overdueCount" INTEGER NOT NULL DEFAULT 0,
    "inAppNotified" BOOLEAN NOT NULL DEFAULT false,
    -- 'skipped' | 'sent' | 'failed' | 'dead'. `skipped` is a first-class
    -- outcome, not a failure: no staff phone, WhatsApp off, no template, or an
    -- unhealthy sender.
    "whatsappStatus" TEXT NOT NULL DEFAULT 'skipped',
    "whatsappReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffDigestRun_pkey" PRIMARY KEY ("id")
);

-- THE idempotency guard. A scheduler that fires twice, or a container that
-- restarts mid-run, cannot send somebody their list a second time. Enforced by
-- the database rather than by a check-then-insert, which races.
CREATE UNIQUE INDEX "StaffDigestRun_userId_businessDate_key"
  ON "StaffDigestRun"("userId", "businessDate");

CREATE INDEX "StaffDigestRun_organisationId_businessDate_idx"
  ON "StaffDigestRun"("organisationId", "businessDate");

ALTER TABLE "StaffDigestSettings"
    ADD CONSTRAINT "StaffDigestSettings_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffDigestRun"
    ADD CONSTRAINT "StaffDigestRun_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE: a digest for a deleted staff member describes nobody.
ALTER TABLE "StaffDigestRun"
    ADD CONSTRAINT "StaffDigestRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
