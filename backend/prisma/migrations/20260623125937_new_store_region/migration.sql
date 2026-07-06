-- AlterTable
ALTER TABLE "NewStoreProject" ADD COLUMN     "regionId" TEXT;

-- CreateIndex
CREATE INDEX "NewStoreProject_regionId_idx" ON "NewStoreProject"("regionId");
