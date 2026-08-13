-- Module 9 — inter-store Stock Transfer workflow. Fully additive.
-- State machine: draft → submitted → ho_approved → dispatched → received → acknowledged
-- (with rejected/cancelled terminals). The only inventory mutation is at receive.

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('draft', 'submitted', 'ho_approved', 'dispatched', 'received', 'acknowledged', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "stockTransferId" TEXT;

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'draft',
    "fromStoreId" TEXT NOT NULL,
    "toStoreId" TEXT NOT NULL,
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT,

    CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_ref_key" ON "StockTransfer"("ref");

-- CreateIndex
CREATE INDEX "StockTransfer_fromStoreId_createdAt_idx" ON "StockTransfer"("fromStoreId", "createdAt");

-- CreateIndex
CREATE INDEX "StockTransfer_toStoreId_createdAt_idx" ON "StockTransfer"("toStoreId", "createdAt");

-- CreateIndex
CREATE INDEX "StockTransfer_status_idx" ON "StockTransfer"("status");

-- CreateIndex
CREATE INDEX "StockTransferItem_stockItemId_idx" ON "StockTransferItem"("stockItemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferItem_transferId_stockItemId_key" ON "StockTransferItem"("transferId", "stockItemId");

-- CreateIndex
CREATE INDEX "StockMovement_stockTransferId_idx" ON "StockMovement"("stockTransferId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockTransferId_fkey" FOREIGN KEY ("stockTransferId") REFERENCES "StockTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromStoreId_fkey" FOREIGN KEY ("fromStoreId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toStoreId_fkey" FOREIGN KEY ("toStoreId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
