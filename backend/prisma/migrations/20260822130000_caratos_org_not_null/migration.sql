-- CaratOS Phase 2B — enforce organisationId NOT NULL on the 47 anchored models.
--
-- ScheduledJobRun, WhatsAppEvent and WhatsAppSession are deliberately EXCLUDED:
-- they are legitimately org-less (global maintenance jobs, and inbound webhook
-- events whose sender's organisation is unknown until processing).
--
-- Idempotent backfill first: any row still carrying a NULL organisationId is
-- stamped to Eclat (organisation #1) before the constraint is added. On prod this
-- is a safety net over the earlier caratos_backfill_eclat_org step; on a DB with
-- no nulls it affects zero rows. Then every org FK is re-created ON DELETE
-- RESTRICT (a tenant's rows must not be silently orphaned) and the column is set
-- NOT NULL.

-- Backfill (idempotent). Eclat is the sole/first organisation; a NULL org row can
-- only be pre-tenancy Eclat data.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
'Region','Store','User','WhatsAppIdentity','WhatsAppLinkCode','DiscountLimit','DiscountPreset','Party','Lead','MetalRate','Quote','Product','ProductEmbedding','SimilaritySearchFeedback','StockItem','StockMovement','StockTransfer','Sale','SaleLine','ManufacturingOrder','ManufacturingOrderItem','ProductionBag','CustomOrder','LedgerEntry','Payment','AttendanceRecord','Shift','StoreHoliday','LeaveRequest','AttendanceRegularization','CheckIn','SchemePlan','SchemeMember','ReferralCode','Ticket','SpecialRequest','ReturnRecord','DiamondRate','DiscountRequest','MarketingCampaign','NewStoreProject','SyncState','Task','Handoff','DailyReport','LegacyRow','AuditLog'
  ]) LOOP
    EXECUTE format('UPDATE %I SET "organisationId" = ''org_eclat'' WHERE "organisationId" IS NULL', t);
  END LOOP;
END $$;

-- DropForeignKey
ALTER TABLE "Region" DROP CONSTRAINT "Region_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Store" DROP CONSTRAINT "Store_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "WhatsAppIdentity" DROP CONSTRAINT "WhatsAppIdentity_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "WhatsAppLinkCode" DROP CONSTRAINT "WhatsAppLinkCode_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "DiscountLimit" DROP CONSTRAINT "DiscountLimit_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "DiscountPreset" DROP CONSTRAINT "DiscountPreset_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Party" DROP CONSTRAINT "Party_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "MetalRate" DROP CONSTRAINT "MetalRate_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Quote" DROP CONSTRAINT "Quote_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "ProductEmbedding" DROP CONSTRAINT "ProductEmbedding_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "SimilaritySearchFeedback" DROP CONSTRAINT "SimilaritySearchFeedback_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "StockItem" DROP CONSTRAINT "StockItem_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "StockTransfer" DROP CONSTRAINT "StockTransfer_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Sale" DROP CONSTRAINT "Sale_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "SaleLine" DROP CONSTRAINT "SaleLine_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "ManufacturingOrder" DROP CONSTRAINT "ManufacturingOrder_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "ManufacturingOrderItem" DROP CONSTRAINT "ManufacturingOrderItem_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "ProductionBag" DROP CONSTRAINT "ProductionBag_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "CustomOrder" DROP CONSTRAINT "CustomOrder_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Shift" DROP CONSTRAINT "Shift_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "StoreHoliday" DROP CONSTRAINT "StoreHoliday_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "LeaveRequest" DROP CONSTRAINT "LeaveRequest_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "AttendanceRegularization" DROP CONSTRAINT "AttendanceRegularization_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "CheckIn" DROP CONSTRAINT "CheckIn_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "SchemePlan" DROP CONSTRAINT "SchemePlan_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "SchemeMember" DROP CONSTRAINT "SchemeMember_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "ReferralCode" DROP CONSTRAINT "ReferralCode_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "SpecialRequest" DROP CONSTRAINT "SpecialRequest_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "ReturnRecord" DROP CONSTRAINT "ReturnRecord_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "DiamondRate" DROP CONSTRAINT "DiamondRate_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "DiscountRequest" DROP CONSTRAINT "DiscountRequest_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "MarketingCampaign" DROP CONSTRAINT "MarketingCampaign_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "NewStoreProject" DROP CONSTRAINT "NewStoreProject_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "SyncState" DROP CONSTRAINT "SyncState_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Handoff" DROP CONSTRAINT "Handoff_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "DailyReport" DROP CONSTRAINT "DailyReport_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "LegacyRow" DROP CONSTRAINT "LegacyRow_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_organisationId_fkey";

-- AlterTable
ALTER TABLE "Region" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Store" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WhatsAppIdentity" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WhatsAppLinkCode" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DiscountLimit" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DiscountPreset" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Party" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MetalRate" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Quote" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductEmbedding" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SimilaritySearchFeedback" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockItem" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockMovement" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StockTransfer" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Sale" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SaleLine" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ManufacturingOrder" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ManufacturingOrderItem" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductionBag" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomOrder" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LedgerEntry" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AttendanceRecord" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Shift" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StoreHoliday" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LeaveRequest" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AttendanceRegularization" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CheckIn" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SchemePlan" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SchemeMember" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReferralCode" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SpecialRequest" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReturnRecord" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DiamondRate" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DiscountRequest" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MarketingCampaign" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "NewStoreProject" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SyncState" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Handoff" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DailyReport" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LegacyRow" ALTER COLUMN "organisationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "organisationId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppIdentity" ADD CONSTRAINT "WhatsAppIdentity_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppLinkCode" ADD CONSTRAINT "WhatsAppLinkCode_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountLimit" ADD CONSTRAINT "DiscountLimit_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountPreset" ADD CONSTRAINT "DiscountPreset_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetalRate" ADD CONSTRAINT "MetalRate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEmbedding" ADD CONSTRAINT "ProductEmbedding_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimilaritySearchFeedback" ADD CONSTRAINT "SimilaritySearchFeedback_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrder" ADD CONSTRAINT "ManufacturingOrder_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrderItem" ADD CONSTRAINT "ManufacturingOrderItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBag" ADD CONSTRAINT "ProductionBag_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreHoliday" ADD CONSTRAINT "StoreHoliday_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegularization" ADD CONSTRAINT "AttendanceRegularization_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemePlan" ADD CONSTRAINT "SchemePlan_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeMember" ADD CONSTRAINT "SchemeMember_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialRequest" ADD CONSTRAINT "SpecialRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiamondRate" ADD CONSTRAINT "DiamondRate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRequest" ADD CONSTRAINT "DiscountRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewStoreProject" ADD CONSTRAINT "NewStoreProject_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyRow" ADD CONSTRAINT "LegacyRow_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

