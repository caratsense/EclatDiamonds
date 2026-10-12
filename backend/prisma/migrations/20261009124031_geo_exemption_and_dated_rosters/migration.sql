-- Edited by hand after `migrate dev`: the generated script also dropped three
-- indexes live queries use (CheckIn_attendedById_idx, Handoff_assignedToId_idx,
-- User_approvalStatus_idx), turned the audit log's actor rule from RESTRICT to
-- SET NULL, and removed ImportBatch.updatedAt's default. None of that belongs
-- to this change (earlier migrations kept the same drift on purpose); the schema
-- now declares all four, so the diff no longer proposes them.

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "geoWaived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "geoExempt" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StaffDayOff" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT,
    "date" DATE NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffDayOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffDayOff_organisationId_storeId_date_idx" ON "StaffDayOff"("organisationId", "storeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StaffDayOff_userId_date_key" ON "StaffDayOff"("userId", "date");

-- AddForeignKey
ALTER TABLE "StaffDayOff" ADD CONSTRAINT "StaffDayOff_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffDayOff" ADD CONSTRAINT "StaffDayOff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AdSpendCoverage_org_asset_date_key" RENAME TO "AdSpendCoverage_organisationId_adAccountAssetId_date_key";
