-- Attendance / approvals / ordering hardening (2026-07-29).
--
-- Everything here is ADDITIVE: new enum values, new nullable columns, new
-- defaults and new indexes. No column is dropped or retyped, so the migration is
-- safe to run against the live database while the previous build is still up.

-- The new enum labels this build relies on are added in the preceding
-- `20260729115900_attendance_enum_values` migration, so they are committed by
-- the time anything here (or in the application) references them.

-- ---------------------------------------------------------------------------
-- 1. Store — IANA timezone. Every shift/lateness/business-date calculation is
--    resolved in the store's own zone instead of the server's UTC clock.
-- ---------------------------------------------------------------------------
ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- ---------------------------------------------------------------------------
-- 3. AttendanceRecord — check-out geo, overtime / early-out, payroll day credit,
--    punch provenance and out-of-fence justification.
-- ---------------------------------------------------------------------------
ALTER TABLE "AttendanceRecord"
  ADD COLUMN IF NOT EXISTS "checkOutDistanceM" INTEGER,
  ADD COLUMN IF NOT EXISTS "checkOutVerified"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "earlyOutMinutes"   INTEGER,
  ADD COLUMN IF NOT EXISTS "overtimeMins"      INTEGER,
  ADD COLUMN IF NOT EXISTS "dayFraction"       DECIMAL(3,2),
  ADD COLUMN IF NOT EXISTS "isMockLocation"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "checkInNote"       TEXT,
  ADD COLUMN IF NOT EXISTS "checkOutNote"      TEXT,
  ADD COLUMN IF NOT EXISTS "source"            TEXT NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS "autoClosed"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "AttendanceRecord_staffId_date_idx"
  ON "AttendanceRecord" ("staffId", "date");

-- ---------------------------------------------------------------------------
-- 4. Shift — configurable full-day / half-day thresholds. NULL keeps the
--    derived defaults (full = scheduled duration, half = 50% of full).
-- ---------------------------------------------------------------------------
ALTER TABLE "Shift"
  ADD COLUMN IF NOT EXISTS "fullDayMins" INTEGER,
  ADD COLUMN IF NOT EXISTS "halfDayMins" INTEGER;

-- ---------------------------------------------------------------------------
-- 5. LeaveRequest / AttendanceRegularization — decision attribution.
--    Previously a decision recorded only the resulting status: there was no
--    record of WHO approved it or WHY.
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveRequest"
  ADD COLUMN IF NOT EXISTS "decidedById"   TEXT,
  ADD COLUMN IF NOT EXISTS "decidedByName" TEXT,
  ADD COLUMN IF NOT EXISTS "decidedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "decisionNote"  TEXT,
  ADD COLUMN IF NOT EXISTS "cancelledAt"   TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "LeaveRequest_staffId_status_idx"
  ON "LeaveRequest" ("staffId", "status");

ALTER TABLE "AttendanceRegularization"
  ADD COLUMN IF NOT EXISTS "decidedById"   TEXT,
  ADD COLUMN IF NOT EXISTS "decidedByName" TEXT,
  ADD COLUMN IF NOT EXISTS "decidedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "decisionNote"  TEXT;

CREATE INDEX IF NOT EXISTS "AttendanceRegularization_staffId_status_idx"
  ON "AttendanceRegularization" ("staffId", "status");

-- ---------------------------------------------------------------------------
-- 6. CustomOrder — stage governance: time-in-stage, cancellation reason and
--    handover record.
-- ---------------------------------------------------------------------------
ALTER TABLE "CustomOrder"
  ADD COLUMN IF NOT EXISTS "stageEnteredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "cancelledAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredTo"    TEXT,
  ADD COLUMN IF NOT EXISTS "deliveredAt"    TIMESTAMP(3);

-- Backfill: treat every existing order as having entered its current stage when
-- its most recent stage event fired, else at creation. Without this, freshly
-- migrated orders would all report a time-in-stage of "unknown".
UPDATE "CustomOrder" o
SET "stageEnteredAt" = COALESCE(
  (SELECT MAX(e."occurredAt") FROM "CustomOrderEvent" e WHERE e."orderId" = o."id"),
  o."createdAt"
)
WHERE o."stageEnteredAt" IS NULL;

-- ---------------------------------------------------------------------------
-- 6b. ReturnRecord — requester identity, so self-approval can be detected.
--     `raisedBy` is a display name and cannot be compared to the approver's id.
-- ---------------------------------------------------------------------------
ALTER TABLE "ReturnRecord"
  ADD COLUMN IF NOT EXISTS "raisedById" TEXT;

-- ---------------------------------------------------------------------------
-- 7. DocSequence — race-free, gap-free document reference counters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "DocSequence" (
  "scope"     TEXT NOT NULL,
  "next"      INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocSequence_pkey" PRIMARY KEY ("scope")
);
