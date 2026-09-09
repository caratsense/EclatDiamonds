-- CRM: preserve the ad a conversation came from, and the rule that routed it.
--
-- ADDITIVE ONLY. Five nullable columns and one index. No DROP, no DELETE, no
-- TRUNCATE, no type change, no NOT NULL: every existing Conversation row stays
-- exactly as it is and reads back identically.
--
-- These mirror the opaque provider identifiers already stored on
-- AttributionTouch. Duplicated deliberately so the inbox can badge a thread with
-- its source ad without joining the attribution table on every list query.
--
-- All five are NULLABLE and stay null for organic/unknown traffic. A null here
-- means "the provider did not tell us" — it is not evidence of an organic
-- source, and no read path is permitted to render it as one.

ALTER TABLE "Conversation" ADD COLUMN "sourceAdId"       TEXT;
ALTER TABLE "Conversation" ADD COLUMN "sourceAdSetId"    TEXT;
ALTER TABLE "Conversation" ADD COLUMN "sourceCampaignId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "sourceClickId"    TEXT;
ALTER TABLE "Conversation" ADD COLUMN "matchedRuleId"    TEXT;

-- Supports "show me every conversation from this ad" in the inbox and in ROAS
-- reporting. Tenant-first so it stays usable under organisation scoping.
CREATE INDEX "Conversation_organisationId_sourceAdId_idx"
  ON "Conversation" ("organisationId", "sourceAdId");
