-- Attendance-only locations (Head Office) and the per-location confirmation that
-- weekly offs, holidays, shifts and grace are configured. Additive; existing
-- stores stay trading branches with rules unconfirmed (no automatic absence).
--
-- Down: ALTER TABLE "Store" DROP COLUMN "attendanceOnly", DROP COLUMN "attendanceRulesConfirmedThrough";
ALTER TABLE "Store" ADD COLUMN "attendanceOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Store" ADD COLUMN "attendanceRulesConfirmedThrough" DATE;
