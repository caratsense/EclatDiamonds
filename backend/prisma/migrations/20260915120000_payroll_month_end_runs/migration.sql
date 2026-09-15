-- Month-end payroll drafts, and the record of every run.
--
-- A branch's month closes at midnight WHERE THE BRANCH IS, and the scheduler
-- drafts that month's payslips then. It never issues one: issuing stays a
-- person's act, because an issued slip is what the employee is shown.
--
-- PayrollRun is the answer to "did August's payroll actually get drafted, and
-- what happened?" — which nothing recorded before. The scheduler's own run
-- carries a unique claim key, so a retried tick, a restart or a second replica
-- cannot draft the same branch-month twice. A person's re-run has no key and may
-- be repeated as often as needed; the payslips themselves are already unique per
-- (userId, periodKey).
--
-- Payslip.difference flags an ISSUED slip the register no longer agrees with,
-- without touching the issued figures.
--
-- All additive.

CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    -- 'scheduler' | 'user'
    "trigger" TEXT NOT NULL,
    "triggeredById" TEXT,
    "triggeredByName" TEXT,
    -- 'started' | 'completed' | 'failed'
    "status" TEXT NOT NULL DEFAULT 'started',
    "generated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "issued" INTEGER NOT NULL DEFAULT 0,
    "differences" INTEGER NOT NULL DEFAULT 0,
    "skippedDetail" JSONB,
    "error" TEXT,
    "schedulerKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- NULLs are distinct in Postgres, so this constrains the scheduler's runs only.
CREATE UNIQUE INDEX "PayrollRun_schedulerKey_key" ON "PayrollRun"("schedulerKey");
CREATE INDEX "PayrollRun_organisationId_storeId_periodKey_idx"
    ON "PayrollRun"("organisationId", "storeId", "periodKey");

ALTER TABLE "PayrollRun"
    ADD CONSTRAINT "PayrollRun_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payslip" ADD COLUMN "difference" JSONB;
ALTER TABLE "Payslip" ADD COLUMN "differenceDetectedAt" TIMESTAMP(3);
