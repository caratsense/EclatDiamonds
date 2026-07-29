-- Enum extensions for the attendance/approvals hardening (2026-07-29).
--
-- Deliberately kept in its OWN migration, ahead of the columns that go with it.
-- Postgres allows `ALTER TYPE … ADD VALUE` inside a transaction block, but the
-- new label cannot be USED by another statement in that same transaction — and
-- Prisma wraps each migration file in one. Isolating the labels here means the
-- next migration (and the application) can reference them safely.

-- Attendance can now record a short day, and the end-of-day close writes an
-- explicit non-working day instead of leaving a gap that reads as absence.
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'half_day';
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'week_off';
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'holiday';

-- A leave request can be withdrawn by the applicant or revoked by a manager,
-- which releases the days it had reserved.
ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'cancelled';
