-- CaratOS Phase B3 -- PostgreSQL row-level security.
--
-- ############################################################################
-- ##  THIS MIGRATION CREATES POLICIES IN A DISABLED STATE. IT CHANGES NOTHING. ##
-- ############################################################################
--
-- Policies are created and RLS is left DISABLED on every table, so query
-- behaviour is identical before and after this runs. Turning it on is a separate,
-- deliberate step (see the companion `_rls_enable` migration, which is written
-- and must NOT be applied until the blocker below is cleared).
--
-- WHY IT IS NOT SIMPLY ENABLED
--
-- These policies read `app.current_organisation`, a transaction-scoped setting.
-- Any query that runs without it returns ZERO ROWS once RLS is forced, and the
-- application does not yet establish that context on every path:
--
--   * ordinary request handlers query outside any transaction, so there is
--     nowhere for a SET LOCAL to live;
--   * several services open interactive transactions of their own (the sync
--     reset, loyalty enrolment, sale creation) which would each need the context
--     set inside them;
--   * the scheduler and job worker span tenants deliberately and need the
--     platform bypass opened explicitly.
--
-- Enabling before those are wired would not leak data -- it would take the whole
-- application down. That is the safer failure, but it is still an outage.
-- Creating the policies now means the SQL is reviewed, versioned and validated
-- against a real database ahead of the change that switches it on.
--
-- SCOPE
--
--   * 65 tables carry a NON-NULLABLE organisationId and get a strict policy.
--   * 5 carry a NULLABLE organisationId (deliberately unattributed rows: a
--     webhook that resolved to no tenant, a platform job). NULL is visible only
--     under the platform bypass.
--   * 24 child/bridge tables own no organisationId and are NOT covered. Their
--     ownership runs through a parent FK and each would need its own EXISTS
--     sub-query. Writing that many without the isolation suite to prove each one
--     is exactly how weak policies get shipped, so they are listed at the bottom
--     as outstanding rather than guessed at.
--   * Organisation, DocSequence and LoginOtp are platform-owned by design and are
--     intentionally excluded.

-- The shared predicate, as a function so the rule has ONE definition.
-- STABLE + PARALLEL SAFE so the planner treats it as constant per statement.
CREATE OR REPLACE FUNCTION caratos_current_org() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT NULLIF(current_setting('app.current_organisation', true), '')
$fn$;

CREATE OR REPLACE FUNCTION caratos_platform_bypass() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(current_setting('app.platform_bypass', true), 'off') = 'on'
$fn$;


-- ========================= strict tenant-owned tables =========================

DROP POLICY IF EXISTS "ActivityEvent_tenant_isolation" ON "ActivityEvent";
CREATE POLICY "ActivityEvent_tenant_isolation" ON "ActivityEvent"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ActivityEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AttendanceRecord_tenant_isolation" ON "AttendanceRecord";
CREATE POLICY "AttendanceRecord_tenant_isolation" ON "AttendanceRecord"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "AttendanceRecord" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AttendanceRegularization_tenant_isolation" ON "AttendanceRegularization";
CREATE POLICY "AttendanceRegularization_tenant_isolation" ON "AttendanceRegularization"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "AttendanceRegularization" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AttributeDefinition_tenant_isolation" ON "AttributeDefinition";
CREATE POLICY "AttributeDefinition_tenant_isolation" ON "AttributeDefinition"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "AttributeDefinition" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AttributionTouch_tenant_isolation" ON "AttributionTouch";
CREATE POLICY "AttributionTouch_tenant_isolation" ON "AttributionTouch"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "AttributionTouch" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AuditLog_tenant_isolation" ON "AuditLog";
CREATE POLICY "AuditLog_tenant_isolation" ON "AuditLog"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "AuditLog" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CheckIn_tenant_isolation" ON "CheckIn";
CREATE POLICY "CheckIn_tenant_isolation" ON "CheckIn"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "CheckIn" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ConnectAgent_tenant_isolation" ON "ConnectAgent";
CREATE POLICY "ConnectAgent_tenant_isolation" ON "ConnectAgent"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ConnectAgent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ContactPoint_tenant_isolation" ON "ContactPoint";
CREATE POLICY "ContactPoint_tenant_isolation" ON "ContactPoint"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ContactPoint" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Conversation_tenant_isolation" ON "Conversation";
CREATE POLICY "Conversation_tenant_isolation" ON "Conversation"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Conversation" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CustomOrder_tenant_isolation" ON "CustomOrder";
CREATE POLICY "CustomOrder_tenant_isolation" ON "CustomOrder"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "CustomOrder" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "DailyReport_tenant_isolation" ON "DailyReport";
CREATE POLICY "DailyReport_tenant_isolation" ON "DailyReport"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "DailyReport" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "DiamondRate_tenant_isolation" ON "DiamondRate";
CREATE POLICY "DiamondRate_tenant_isolation" ON "DiamondRate"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "DiamondRate" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "DiscountLimit_tenant_isolation" ON "DiscountLimit";
CREATE POLICY "DiscountLimit_tenant_isolation" ON "DiscountLimit"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "DiscountLimit" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "DiscountPreset_tenant_isolation" ON "DiscountPreset";
CREATE POLICY "DiscountPreset_tenant_isolation" ON "DiscountPreset"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "DiscountPreset" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "DiscountRequest_tenant_isolation" ON "DiscountRequest";
CREATE POLICY "DiscountRequest_tenant_isolation" ON "DiscountRequest"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "DiscountRequest" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "FieldPolicy_tenant_isolation" ON "FieldPolicy";
CREATE POLICY "FieldPolicy_tenant_isolation" ON "FieldPolicy"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "FieldPolicy" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Handoff_tenant_isolation" ON "Handoff";
CREATE POLICY "Handoff_tenant_isolation" ON "Handoff"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Handoff" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ImportBatch_tenant_isolation" ON "ImportBatch";
CREATE POLICY "ImportBatch_tenant_isolation" ON "ImportBatch"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ImportBatch" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Integration_tenant_isolation" ON "Integration";
CREATE POLICY "Integration_tenant_isolation" ON "Integration"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Integration" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "IntegrationAsset_tenant_isolation" ON "IntegrationAsset";
CREATE POLICY "IntegrationAsset_tenant_isolation" ON "IntegrationAsset"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "IntegrationAsset" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "IntegrationCredential_tenant_isolation" ON "IntegrationCredential";
CREATE POLICY "IntegrationCredential_tenant_isolation" ON "IntegrationCredential"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "IntegrationCredential" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Lead_tenant_isolation" ON "Lead";
CREATE POLICY "Lead_tenant_isolation" ON "Lead"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Lead" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "LeadQualification_tenant_isolation" ON "LeadQualification";
CREATE POLICY "LeadQualification_tenant_isolation" ON "LeadQualification"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "LeadQualification" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "LeaveRequest_tenant_isolation" ON "LeaveRequest";
CREATE POLICY "LeaveRequest_tenant_isolation" ON "LeaveRequest"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "LeaveRequest" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "LedgerEntry_tenant_isolation" ON "LedgerEntry";
CREATE POLICY "LedgerEntry_tenant_isolation" ON "LedgerEntry"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "LedgerEntry" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "LegacyRow_tenant_isolation" ON "LegacyRow";
CREATE POLICY "LegacyRow_tenant_isolation" ON "LegacyRow"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "LegacyRow" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ManufacturingOrder_tenant_isolation" ON "ManufacturingOrder";
CREATE POLICY "ManufacturingOrder_tenant_isolation" ON "ManufacturingOrder"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ManufacturingOrder" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ManufacturingOrderItem_tenant_isolation" ON "ManufacturingOrderItem";
CREATE POLICY "ManufacturingOrderItem_tenant_isolation" ON "ManufacturingOrderItem"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ManufacturingOrderItem" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "MarketingCampaign_tenant_isolation" ON "MarketingCampaign";
CREATE POLICY "MarketingCampaign_tenant_isolation" ON "MarketingCampaign"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "MarketingCampaign" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "MergeCandidate_tenant_isolation" ON "MergeCandidate";
CREATE POLICY "MergeCandidate_tenant_isolation" ON "MergeCandidate"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "MergeCandidate" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Message_tenant_isolation" ON "Message";
CREATE POLICY "Message_tenant_isolation" ON "Message"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Message" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "MetalRate_tenant_isolation" ON "MetalRate";
CREATE POLICY "MetalRate_tenant_isolation" ON "MetalRate"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "MetalRate" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "NewStoreProject_tenant_isolation" ON "NewStoreProject";
CREATE POLICY "NewStoreProject_tenant_isolation" ON "NewStoreProject"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "NewStoreProject" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Party_tenant_isolation" ON "Party";
CREATE POLICY "Party_tenant_isolation" ON "Party"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Party" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Payment_tenant_isolation" ON "Payment";
CREATE POLICY "Payment_tenant_isolation" ON "Payment"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Payment" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pipeline_tenant_isolation" ON "Pipeline";
CREATE POLICY "Pipeline_tenant_isolation" ON "Pipeline"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Pipeline" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "PipelineStage_tenant_isolation" ON "PipelineStage";
CREATE POLICY "PipelineStage_tenant_isolation" ON "PipelineStage"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "PipelineStage" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Product_tenant_isolation" ON "Product";
CREATE POLICY "Product_tenant_isolation" ON "Product"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Product" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductEmbedding_tenant_isolation" ON "ProductEmbedding";
CREATE POLICY "ProductEmbedding_tenant_isolation" ON "ProductEmbedding"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductEmbedding" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductInteraction_tenant_isolation" ON "ProductInteraction";
CREATE POLICY "ProductInteraction_tenant_isolation" ON "ProductInteraction"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductInteraction" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductionBag_tenant_isolation" ON "ProductionBag";
CREATE POLICY "ProductionBag_tenant_isolation" ON "ProductionBag"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductionBag" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Quote_tenant_isolation" ON "Quote";
CREATE POLICY "Quote_tenant_isolation" ON "Quote"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Quote" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ReferralCode_tenant_isolation" ON "ReferralCode";
CREATE POLICY "ReferralCode_tenant_isolation" ON "ReferralCode"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ReferralCode" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Region_tenant_isolation" ON "Region";
CREATE POLICY "Region_tenant_isolation" ON "Region"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Region" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ReturnRecord_tenant_isolation" ON "ReturnRecord";
CREATE POLICY "ReturnRecord_tenant_isolation" ON "ReturnRecord"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ReturnRecord" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sale_tenant_isolation" ON "Sale";
CREATE POLICY "Sale_tenant_isolation" ON "Sale"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Sale" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SaleLine_tenant_isolation" ON "SaleLine";
CREATE POLICY "SaleLine_tenant_isolation" ON "SaleLine"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "SaleLine" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SchemeMember_tenant_isolation" ON "SchemeMember";
CREATE POLICY "SchemeMember_tenant_isolation" ON "SchemeMember"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "SchemeMember" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SchemePlan_tenant_isolation" ON "SchemePlan";
CREATE POLICY "SchemePlan_tenant_isolation" ON "SchemePlan"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "SchemePlan" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Shift_tenant_isolation" ON "Shift";
CREATE POLICY "Shift_tenant_isolation" ON "Shift"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Shift" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SimilaritySearchFeedback_tenant_isolation" ON "SimilaritySearchFeedback";
CREATE POLICY "SimilaritySearchFeedback_tenant_isolation" ON "SimilaritySearchFeedback"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "SimilaritySearchFeedback" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SpecialRequest_tenant_isolation" ON "SpecialRequest";
CREATE POLICY "SpecialRequest_tenant_isolation" ON "SpecialRequest"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "SpecialRequest" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "StockItem_tenant_isolation" ON "StockItem";
CREATE POLICY "StockItem_tenant_isolation" ON "StockItem"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "StockItem" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "StockMovement_tenant_isolation" ON "StockMovement";
CREATE POLICY "StockMovement_tenant_isolation" ON "StockMovement"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "StockMovement" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "StockTransfer_tenant_isolation" ON "StockTransfer";
CREATE POLICY "StockTransfer_tenant_isolation" ON "StockTransfer"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "StockTransfer" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Store_tenant_isolation" ON "Store";
CREATE POLICY "Store_tenant_isolation" ON "Store"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Store" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "StoreHoliday_tenant_isolation" ON "StoreHoliday";
CREATE POLICY "StoreHoliday_tenant_isolation" ON "StoreHoliday"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "StoreHoliday" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SyncState_tenant_isolation" ON "SyncState";
CREATE POLICY "SyncState_tenant_isolation" ON "SyncState"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "SyncState" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Task_tenant_isolation" ON "Task";
CREATE POLICY "Task_tenant_isolation" ON "Task"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Task" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "TaxonomyTerm_tenant_isolation" ON "TaxonomyTerm";
CREATE POLICY "TaxonomyTerm_tenant_isolation" ON "TaxonomyTerm"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "TaxonomyTerm" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ticket_tenant_isolation" ON "Ticket";
CREATE POLICY "Ticket_tenant_isolation" ON "Ticket"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Ticket" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "User_tenant_isolation" ON "User";
CREATE POLICY "User_tenant_isolation" ON "User"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WhatsAppIdentity_tenant_isolation" ON "WhatsAppIdentity";
CREATE POLICY "WhatsAppIdentity_tenant_isolation" ON "WhatsAppIdentity"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "WhatsAppIdentity" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WhatsAppLinkCode_tenant_isolation" ON "WhatsAppLinkCode";
CREATE POLICY "WhatsAppLinkCode_tenant_isolation" ON "WhatsAppLinkCode"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "WhatsAppLinkCode" DISABLE ROW LEVEL SECURITY;


-- =================== tenant-owned, NULLABLE organisationId ===================
-- NULL means 'deliberately unattributed' and is visible ONLY to the platform.

DROP POLICY IF EXISTS "JobTask_tenant_isolation" ON "JobTask";
CREATE POLICY "JobTask_tenant_isolation" ON "JobTask"
  USING (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()))
  WITH CHECK (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()));
ALTER TABLE "JobTask" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ScheduledJobRun_tenant_isolation" ON "ScheduledJobRun";
CREATE POLICY "ScheduledJobRun_tenant_isolation" ON "ScheduledJobRun"
  USING (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()))
  WITH CHECK (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()));
ALTER TABLE "ScheduledJobRun" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WebhookEvent_tenant_isolation" ON "WebhookEvent";
CREATE POLICY "WebhookEvent_tenant_isolation" ON "WebhookEvent"
  USING (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()))
  WITH CHECK (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()));
ALTER TABLE "WebhookEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WhatsAppEvent_tenant_isolation" ON "WhatsAppEvent";
CREATE POLICY "WhatsAppEvent_tenant_isolation" ON "WhatsAppEvent"
  USING (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()))
  WITH CHECK (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()));
ALTER TABLE "WhatsAppEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WhatsAppSession_tenant_isolation" ON "WhatsAppSession";
CREATE POLICY "WhatsAppSession_tenant_isolation" ON "WhatsAppSession"
  USING (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()))
  WITH CHECK (caratos_platform_bypass() OR ("organisationId" IS NOT NULL AND "organisationId" = caratos_current_org()));
ALTER TABLE "WhatsAppSession" DISABLE ROW LEVEL SECURITY;


-- ========================== NOT COVERED (documented) ==========================
-- No organisationId of their own. Ownership is inherited through a parent FK and
-- each needs its own EXISTS policy. Left uncovered until the isolation suite can
-- prove them individually:
--   CampaignStore
--   Commission
--   CustomOrderEvent
--   LeadFollowUp
--   LeadNote
--   LeaveBalance
--   MarketingAsset
--   NewStoreChecklistItem
--   NewStoreMilestone
--   NewStoreVendor
--   Notification
--   OccasionReminder
--   QuoteLine
--   QuotePhoto
--   QuoteRedeemableStore
--   Referral
--   ReferralPayout
--   ReturnPhoto
--   SalesTarget
--   SchemeInstallment
--   SpecialRequestMessage
--   StockTransferItem
--   TicketMessage
--   UserStore
