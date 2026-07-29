-- Scheduled-job execution log + single-run guard.
--
-- The unique index is load-bearing, not housekeeping: the cron fires inside every
-- API instance, so without it two replicas would both close the same business day.
-- The first INSERT wins the run; the second gets a unique violation and skips.
CREATE TABLE IF NOT EXISTS "ScheduledJobRun" (
    "id"        TEXT NOT NULL,
    "job"       TEXT NOT NULL,
    "scope"     TEXT NOT NULL,
    "runKey"    TEXT NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'running',
    "detail"    TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"   TIMESTAMP(3),

    CONSTRAINT "ScheduledJobRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledJobRun_job_scope_runKey_key"
    ON "ScheduledJobRun"("job", "scope", "runKey");

CREATE INDEX IF NOT EXISTS "ScheduledJobRun_job_startedAt_idx"
    ON "ScheduledJobRun"("job", "startedAt");
