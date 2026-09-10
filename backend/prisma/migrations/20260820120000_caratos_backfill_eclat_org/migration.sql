-- CaratOS Phase 2 — backfill: make the existing single tenant "Eclat" Organisation #1.
-- Idempotent (safe to re-run): creates the Eclat org if absent, then attributes every
-- pre-existing row to it. All 46 organisationId columns are still NULLABLE at this point;
-- a later, separate migration flips them to NOT NULL once this backfill is verified.

-- 1. The reference organisation. Stable id so tests/seeds can reference it.
INSERT INTO "Organisation" ("id", "name", "slug", "isActive", "createdAt", "updatedAt")
VALUES ('org_eclat', 'Eclat', 'eclat', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- 2. Attribute every existing row to Eclat where unset. One UPDATE per anchored table.
UPDATE "Region"                   SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Store"                    SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "User"                     SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Party"                    SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "MetalRate"                SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "DiamondRate"              SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "DiscountLimit"            SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "DiscountPreset"           SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "SchemePlan"               SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "SyncState"                SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "LegacyRow"                SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ScheduledJobRun"          SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Product"                  SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ProductEmbedding"         SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "SimilaritySearchFeedback" SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Lead"                     SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Quote"                    SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "StockItem"                SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "StockTransfer"            SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Sale"                     SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "SaleLine"                 SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "CustomOrder"              SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ManufacturingOrder"       SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ManufacturingOrderItem"   SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ProductionBag"            SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "LedgerEntry"              SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Payment"                  SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "SchemeMember"             SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Ticket"                   SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "SpecialRequest"           SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ReturnRecord"             SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "DiscountRequest"          SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "CheckIn"                  SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "AttendanceRecord"         SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Shift"                    SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "StoreHoliday"             SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "LeaveRequest"             SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "AttendanceRegularization" SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "MarketingCampaign"        SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "NewStoreProject"          SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Handoff"                  SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "DailyReport"              SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "Task"                     SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "ReferralCode"             SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "StockMovement"            SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
UPDATE "AuditLog"                 SET "organisationId" = 'org_eclat' WHERE "organisationId" IS NULL;
