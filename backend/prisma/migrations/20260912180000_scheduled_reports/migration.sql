-- The month-end report nobody has to remember to run.
--
-- From the meeting: the lead report should arrive on the first of the month
-- rather than being filtered and downloaded by hand. The manual export already
-- shipped and is untouched — this is the same workbook, on a schedule, with the
-- columns the tenant chose.
--
-- Additive throughout, and inert until a tenant creates a report. No defaults
-- here switch anything on for anybody.

CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- 'leads' today. A string, not an enum: the next report shape is a new
    -- value, not a migration that rewrites every existing row.
    "kind" TEXT NOT NULL DEFAULT 'leads',
    -- NULL = every branch in scope.
    "storeId" TEXT,
    -- 'monthly' (1st, for the month just ended) | 'weekly' (Monday, for the week
    -- just ended). Always a COMPLETED period: a file covering three days of a
    -- month is the kind of number somebody quotes in a meeting by mistake.
    "cadence" TEXT NOT NULL DEFAULT 'monthly',
    -- The hour at the BRANCH. The scheduler ticks hourly and asks each report
    -- what time it is where its store is, so a chain across two timezones gets
    -- its report at breakfast in each.
    "sendHour" INTEGER NOT NULL DEFAULT 7,
    -- Which columns, in which order. Empty = all of them. This is the
    -- configurable mapping: a tenant wanting three columns gets three, not
    -- sixteen and an instruction to ignore thirteen.
    "columns" TEXT[],
    "recipients" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledReportRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    -- '2026-08' for a month, '2026-W35' for a week: the period the file COVERS,
    -- not the day it was sent.
    "periodKey" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "rows" INTEGER NOT NULL DEFAULT 0,
    -- 'ok' | 'empty' | 'failed'. `empty` is a real outcome: a branch with no
    -- leads last month gets a row saying so, rather than a blank spreadsheet
    -- that reads like a broken job.
    "status" TEXT NOT NULL DEFAULT 'ok',
    "detail" TEXT,
    -- 'sent' | 'dry_run' | 'no_recipients' | 'failed'. `dry_run` is the honest
    -- label for "SMTP is not configured here" — recording 'sent' would be a lie
    -- the tenant only discovers by asking why nothing arrived.
    "emailStatus" TEXT NOT NULL DEFAULT 'no_recipients',
    "emailDetail" TEXT,
    "recipients" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledReportRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduledReport_organisationId_name_key"
    ON "ScheduledReport"("organisationId", "name");

CREATE INDEX "ScheduledReport_organisationId_isActive_idx"
    ON "ScheduledReport"("organisationId", "isActive");

-- The idempotency guard, and the entire reliability story for this feature. An
-- overlapping tick, a second replica, a restart mid-send and a manual re-run all
-- collide here and the loser does nothing. Nobody gets September's leads twice.
CREATE UNIQUE INDEX "ScheduledReportRun_reportId_periodKey_key"
    ON "ScheduledReportRun"("reportId", "periodKey");

CREATE INDEX "ScheduledReportRun_organisationId_createdAt_idx"
    ON "ScheduledReportRun"("organisationId", "createdAt");

ALTER TABLE "ScheduledReport"
    ADD CONSTRAINT "ScheduledReport_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL: deleting a branch must not silently delete the report definition
-- with it. The report falls back to covering everything, which is visible on the
-- screen, rather than disappearing.
ALTER TABLE "ScheduledReport"
    ADD CONSTRAINT "ScheduledReport_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduledReportRun"
    ADD CONSTRAINT "ScheduledReportRun_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE: a run is a delivery OF a report. Deleting the definition takes its
-- history with it, which is what "delete this report" means to the person
-- pressing the button.
ALTER TABLE "ScheduledReportRun"
    ADD CONSTRAINT "ScheduledReportRun_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "ScheduledReport"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
