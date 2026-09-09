-- CaratOS Phase 2 tenancy: purely additive. Adds the Organisation table and a
-- nullable organisationId (+ index + FK) to the 46 anchored models. Backfilled to
-- the "Eclat" organisation in a follow-up data step; made NOT NULL in a later phase.
-- (Two unrelated pre-existing DROP INDEX statements Prisma proposed for schema<->DB
--  drift on Handoff.assignedToId / User.approvalStatus were removed to keep this
--  migration scoped to tenancy; that drift is tracked separately.)

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "AttendanceRegularization" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "CustomOrder" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "DailyReport" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "DiamondRate" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "DiscountLimit" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "DiscountPreset" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "DiscountRequest" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Handoff" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "LegacyRow" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ManufacturingOrder" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ManufacturingOrderItem" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "MetalRate" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "NewStoreProject" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ProductEmbedding" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ProductionBag" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ReferralCode" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "ScheduledJobRun" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "SchemeMember" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "SchemePlan" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "SimilaritySearchFeedback" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "SpecialRequest" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "StockItem" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "StockTransfer" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "StoreHoliday" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "SyncState" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "organisationId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "organisationId" TEXT;

-- CreateTable
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "gstin" TEXT,
    "legalName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organisation_slug_key" ON "Organisation"("slug");

-- CreateIndex
CREATE INDEX "AttendanceRecord_organisationId_idx" ON "AttendanceRecord"("organisationId");

-- CreateIndex
CREATE INDEX "AttendanceRegularization_organisationId_idx" ON "AttendanceRegularization"("organisationId");

-- CreateIndex
CREATE INDEX "AuditLog_organisationId_idx" ON "AuditLog"("organisationId");

-- CreateIndex
CREATE INDEX "CheckIn_organisationId_idx" ON "CheckIn"("organisationId");

-- CreateIndex
CREATE INDEX "CustomOrder_organisationId_idx" ON "CustomOrder"("organisationId");

-- CreateIndex
CREATE INDEX "DailyReport_organisationId_idx" ON "DailyReport"("organisationId");

-- CreateIndex
CREATE INDEX "DiamondRate_organisationId_idx" ON "DiamondRate"("organisationId");

-- CreateIndex
CREATE INDEX "DiscountLimit_organisationId_idx" ON "DiscountLimit"("organisationId");

-- CreateIndex
CREATE INDEX "DiscountPreset_organisationId_idx" ON "DiscountPreset"("organisationId");

-- CreateIndex
CREATE INDEX "DiscountRequest_organisationId_idx" ON "DiscountRequest"("organisationId");

-- CreateIndex
CREATE INDEX "Handoff_organisationId_idx" ON "Handoff"("organisationId");

-- CreateIndex
CREATE INDEX "Lead_organisationId_idx" ON "Lead"("organisationId");

-- CreateIndex
CREATE INDEX "LeaveRequest_organisationId_idx" ON "LeaveRequest"("organisationId");

-- CreateIndex
CREATE INDEX "LedgerEntry_organisationId_idx" ON "LedgerEntry"("organisationId");

-- CreateIndex
CREATE INDEX "LegacyRow_organisationId_idx" ON "LegacyRow"("organisationId");

-- CreateIndex
CREATE INDEX "ManufacturingOrder_organisationId_idx" ON "ManufacturingOrder"("organisationId");

-- CreateIndex
CREATE INDEX "ManufacturingOrderItem_organisationId_idx" ON "ManufacturingOrderItem"("organisationId");

-- CreateIndex
CREATE INDEX "MarketingCampaign_organisationId_idx" ON "MarketingCampaign"("organisationId");

-- CreateIndex
CREATE INDEX "MetalRate_organisationId_idx" ON "MetalRate"("organisationId");

-- CreateIndex
CREATE INDEX "NewStoreProject_organisationId_idx" ON "NewStoreProject"("organisationId");

-- CreateIndex
CREATE INDEX "Party_organisationId_idx" ON "Party"("organisationId");

-- CreateIndex
CREATE INDEX "Payment_organisationId_idx" ON "Payment"("organisationId");

-- CreateIndex
CREATE INDEX "Product_organisationId_idx" ON "Product"("organisationId");

-- CreateIndex
CREATE INDEX "ProductEmbedding_organisationId_idx" ON "ProductEmbedding"("organisationId");

-- CreateIndex
CREATE INDEX "ProductionBag_organisationId_idx" ON "ProductionBag"("organisationId");

-- CreateIndex
CREATE INDEX "Quote_organisationId_idx" ON "Quote"("organisationId");

-- CreateIndex
CREATE INDEX "ReferralCode_organisationId_idx" ON "ReferralCode"("organisationId");

-- CreateIndex
CREATE INDEX "Region_organisationId_idx" ON "Region"("organisationId");

-- CreateIndex
CREATE INDEX "ReturnRecord_organisationId_idx" ON "ReturnRecord"("organisationId");

-- CreateIndex
CREATE INDEX "Sale_organisationId_idx" ON "Sale"("organisationId");

-- CreateIndex
CREATE INDEX "SaleLine_organisationId_idx" ON "SaleLine"("organisationId");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_organisationId_idx" ON "ScheduledJobRun"("organisationId");

-- CreateIndex
CREATE INDEX "SchemeMember_organisationId_idx" ON "SchemeMember"("organisationId");

-- CreateIndex
CREATE INDEX "SchemePlan_organisationId_idx" ON "SchemePlan"("organisationId");

-- CreateIndex
CREATE INDEX "Shift_organisationId_idx" ON "Shift"("organisationId");

-- CreateIndex
CREATE INDEX "SimilaritySearchFeedback_organisationId_idx" ON "SimilaritySearchFeedback"("organisationId");

-- CreateIndex
CREATE INDEX "SpecialRequest_organisationId_idx" ON "SpecialRequest"("organisationId");

-- CreateIndex
CREATE INDEX "StockItem_organisationId_idx" ON "StockItem"("organisationId");

-- CreateIndex
CREATE INDEX "StockMovement_organisationId_idx" ON "StockMovement"("organisationId");

-- CreateIndex
CREATE INDEX "StockTransfer_organisationId_idx" ON "StockTransfer"("organisationId");

-- CreateIndex
CREATE INDEX "Store_organisationId_idx" ON "Store"("organisationId");

-- CreateIndex
CREATE INDEX "StoreHoliday_organisationId_idx" ON "StoreHoliday"("organisationId");

-- CreateIndex
CREATE INDEX "SyncState_organisationId_idx" ON "SyncState"("organisationId");

-- CreateIndex
CREATE INDEX "Task_organisationId_idx" ON "Task"("organisationId");

-- CreateIndex
CREATE INDEX "Ticket_organisationId_idx" ON "Ticket"("organisationId");

-- CreateIndex
CREATE INDEX "User_organisationId_idx" ON "User"("organisationId");

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJobRun" ADD CONSTRAINT "ScheduledJobRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountLimit" ADD CONSTRAINT "DiscountLimit_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountPreset" ADD CONSTRAINT "DiscountPreset_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetalRate" ADD CONSTRAINT "MetalRate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEmbedding" ADD CONSTRAINT "ProductEmbedding_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimilaritySearchFeedback" ADD CONSTRAINT "SimilaritySearchFeedback_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrder" ADD CONSTRAINT "ManufacturingOrder_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrderItem" ADD CONSTRAINT "ManufacturingOrderItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBag" ADD CONSTRAINT "ProductionBag_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreHoliday" ADD CONSTRAINT "StoreHoliday_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegularization" ADD CONSTRAINT "AttendanceRegularization_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemePlan" ADD CONSTRAINT "SchemePlan_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeMember" ADD CONSTRAINT "SchemeMember_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialRequest" ADD CONSTRAINT "SpecialRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiamondRate" ADD CONSTRAINT "DiamondRate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRequest" ADD CONSTRAINT "DiscountRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewStoreProject" ADD CONSTRAINT "NewStoreProject_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyRow" ADD CONSTRAINT "LegacyRow_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
