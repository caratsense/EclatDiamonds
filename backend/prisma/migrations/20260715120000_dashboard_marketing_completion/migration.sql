-- AlterTable: campaign delivery channels (scalar string list)
ALTER TABLE "MarketingCampaign" ADD COLUMN     "channels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable: per-vendor cost so a new-store project can track budget/spent
ALTER TABLE "NewStoreVendor" ADD COLUMN     "amount" DECIMAL(14,2);

-- CreateTable: cross-department hand-offs (Module 3 collaboration)
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "fromDept" TEXT NOT NULL,
    "toDept" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "assignedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Handoff_storeId_idx" ON "Handoff"("storeId");
CREATE INDEX "Handoff_status_idx" ON "Handoff"("status");

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
