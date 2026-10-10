-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- DropIndex
DROP INDEX "CheckIn_attendedById_idx";

-- DropIndex
DROP INDEX "Handoff_assignedToId_idx";

-- DropIndex
DROP INDEX "User_approvalStatus_idx";

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "geoWaived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ImportBatch" ALTER COLUMN "updatedAt" DROP DEFAULT;

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
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffDayOff" ADD CONSTRAINT "StaffDayOff_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffDayOff" ADD CONSTRAINT "StaffDayOff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AdSpendCoverage_org_asset_date_key" RENAME TO "AdSpendCoverage_organisationId_adAccountAssetId_date_key";
