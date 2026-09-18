-- Dashboard-native attendance hardening.
--
-- 1. Punch retries are tenant-scoped. A connector is not required by the
--    dashboard product, but imported/manual source keys must still never make
--    one organisation suppress another organisation's event.
-- 2. A daily row records the shift inputs that produced it, so editing the
--    current Shift master does not silently reinterpret historical attendance.

ALTER TABLE "AttendanceRecord"
  ADD COLUMN "calculationVersion" TEXT,
  ADD COLUMN "shiftSnapshot" JSONB;

DROP INDEX IF EXISTS "RawPunchEvent_idempotencyKey_key";
CREATE UNIQUE INDEX "RawPunchEvent_organisationId_idempotencyKey_key"
  ON "RawPunchEvent"("organisationId", "idempotencyKey");
