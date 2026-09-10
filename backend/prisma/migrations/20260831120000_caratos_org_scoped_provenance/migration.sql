-- CaratOS Step 2 — org-scoped external-provenance keys.
--
-- Every tenant-owned provenance/identifier that was GLOBALLY unique becomes
-- unique PER ORGANISATION, so `org A + externalId X` can never resolve to
-- `org B + externalId X`. Existing rows are all org_eclat and already unique
-- within that org, so each composite index holds without a data change.
--
-- DROP IF EXISTS guards each single-column index (a drifted dev DB may lack
-- one, e.g. a User.legacyId index that was never materialised).

-- ── 16 legacyId provenance keys: single-column @unique → [organisationId, legacyId] ──
DROP INDEX IF EXISTS "public"."Store_legacyId_key";
CREATE UNIQUE INDEX "Store_organisationId_legacyId_key" ON "public"."Store"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."User_legacyId_key";
CREATE UNIQUE INDEX "User_organisationId_legacyId_key" ON "public"."User"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."Party_legacyId_key";
CREATE UNIQUE INDEX "Party_organisationId_legacyId_key" ON "public"."Party"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."MetalRate_legacyId_key";
CREATE UNIQUE INDEX "MetalRate_organisationId_legacyId_key" ON "public"."MetalRate"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."Product_legacyId_key";
CREATE UNIQUE INDEX "Product_organisationId_legacyId_key" ON "public"."Product"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."StockItem_legacyId_key";
CREATE UNIQUE INDEX "StockItem_organisationId_legacyId_key" ON "public"."StockItem"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."StockMovement_legacyId_key";
CREATE UNIQUE INDEX "StockMovement_organisationId_legacyId_key" ON "public"."StockMovement"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."Sale_legacyId_key";
CREATE UNIQUE INDEX "Sale_organisationId_legacyId_key" ON "public"."Sale"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."SaleLine_legacyId_key";
CREATE UNIQUE INDEX "SaleLine_organisationId_legacyId_key" ON "public"."SaleLine"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."ManufacturingOrder_legacyId_key";
CREATE UNIQUE INDEX "ManufacturingOrder_organisationId_legacyId_key" ON "public"."ManufacturingOrder"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."ManufacturingOrderItem_legacyId_key";
CREATE UNIQUE INDEX "ManufacturingOrderItem_organisationId_legacyId_key" ON "public"."ManufacturingOrderItem"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."ProductionBag_legacyId_key";
CREATE UNIQUE INDEX "ProductionBag_organisationId_legacyId_key" ON "public"."ProductionBag"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."LedgerEntry_legacyId_key";
CREATE UNIQUE INDEX "LedgerEntry_organisationId_legacyId_key" ON "public"."LedgerEntry"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."Payment_legacyId_key";
CREATE UNIQUE INDEX "Payment_organisationId_legacyId_key" ON "public"."Payment"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."SchemeMember_legacyId_key";
CREATE UNIQUE INDEX "SchemeMember_organisationId_legacyId_key" ON "public"."SchemeMember"("organisationId", "legacyId");

DROP INDEX IF EXISTS "public"."ReturnRecord_legacyId_key";
CREATE UNIQUE INDEX "ReturnRecord_organisationId_legacyId_key" ON "public"."ReturnRecord"("organisationId", "legacyId");

-- ── Store.code / Region.code: global @unique → [organisationId, code] ──
DROP INDEX IF EXISTS "public"."Store_code_key";
CREATE UNIQUE INDEX "Store_organisationId_code_key" ON "public"."Store"("organisationId", "code");

DROP INDEX IF EXISTS "public"."Region_code_key";
CREATE UNIQUE INDEX "Region_organisationId_code_key" ON "public"."Region"("organisationId", "code");

-- ── LegacyRow: [sourceTable, rowKey] → [organisationId, sourceTable, rowKey] ──
DROP INDEX IF EXISTS "public"."LegacyRow_sourceTable_rowKey_key";
CREATE UNIQUE INDEX "LegacyRow_organisationId_sourceTable_rowKey_key" ON "public"."LegacyRow"("organisationId", "sourceTable", "rowKey");

-- ── SyncState: [sourceTable, storeId] → [organisationId, sourceTable, storeId] ──
DROP INDEX IF EXISTS "public"."SyncState_sourceTable_storeId_key";
CREATE UNIQUE INDEX "SyncState_organisationId_sourceTable_storeId_key" ON "public"."SyncState"("organisationId", "sourceTable", "storeId");
