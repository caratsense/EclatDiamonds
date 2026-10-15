-- The attendance day as it stood when a correction was FILED (14 Oct).
--
-- Both the ORIGINAL punches the approver screen shows beside the proposal, and
-- the baseline the decision re-checks inside its transaction: approval voids
-- the day's live punches of the kinds it replaces, so a device punch that
-- landed after filing used to be discarded unseen.
--
-- All nullable and backfill-free on purpose. `baselineCapturedAt` is the
-- discriminator: NULL on rows filed before this migration, and those skip the
-- freshness check rather than becoming permanently un-approvable.
ALTER TABLE "AttendanceRegularization"
  ADD COLUMN "originalCheckIn" TIMESTAMP(3),
  ADD COLUMN "originalCheckOut" TIMESTAMP(3),
  ADD COLUMN "originalStatus" "AttendanceStatus",
  ADD COLUMN "originalWorkedMins" INTEGER,
  ADD COLUMN "recordUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "baselineCapturedAt" TIMESTAMP(3);
