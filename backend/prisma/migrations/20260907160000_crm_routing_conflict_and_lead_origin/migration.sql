-- CRM Phase 1 (parts B and C): durable routing-conflict records + concurrency-safe
-- automatic lead creation.
--
-- ADDITIVE ONLY. One new table, one nullable column, one partial-by-NULL unique
-- index. No DROP, no DELETE, no TRUNCATE, no type change, no new required column
-- on an existing table. Every existing row reads back identically.

-- ---------------------------------------------------------------------------
-- 1C — a narrow identity for an AUTOMATICALLY created ad lead.
--
-- NULL for every lead that exists today and for every human-created lead. The
-- unique index therefore constrains only auto-created leads, and because
-- Postgres treats NULLs as DISTINCT it needs no backfill and cannot limit how
-- many legitimate opportunities a customer may have.
-- ---------------------------------------------------------------------------
ALTER TABLE "Lead" ADD COLUMN "originKey" TEXT;

-- Tenant-scoped by construction: organisation is the leading column, so one
-- tenant's click id can never collide with another's.
CREATE UNIQUE INDEX "Lead_organisationId_originKey_key"
  ON "Lead" ("organisationId", "originKey");

-- ---------------------------------------------------------------------------
-- 1B — the routing conflict itself, as queryable state rather than a log line.
-- ---------------------------------------------------------------------------
CREATE TABLE "ConversationRoutingConflict" (
  "id"                     TEXT NOT NULL,
  "organisationId"         TEXT NOT NULL,
  "conversationId"         TEXT NOT NULL,
  "detectedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "originalStoreId"        TEXT,
  "originalAssignedUserId" TEXT,
  "originalRuleId"         TEXT,
  "originalHandling"       TEXT,
  "proposedStoreId"        TEXT,
  "proposedAssignedUserId" TEXT,
  "proposedRuleId"         TEXT,
  "proposedRuleName"       TEXT,
  "proposedHandling"       TEXT,
  "sourceAdId"             TEXT,
  "sourceAdSetId"          TEXT,
  "sourceCampaignId"       TEXT,
  "resolution"             TEXT,
  "resolutionNote"         TEXT,
  "resolvedById"           TEXT,
  "resolvedAt"             TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationRoutingConflict_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationRoutingConflict_organisationId_resolution_detec_idx"
  ON "ConversationRoutingConflict" ("organisationId", "resolution", "detectedAt");
CREATE INDEX "ConversationRoutingConflict_conversationId_detectedAt_idx"
  ON "ConversationRoutingConflict" ("conversationId", "detectedAt");

-- The organisation FK is RESTRICT, matching every other tenant-anchored table:
-- a tenant's rows must never be silently orphaned.
ALTER TABLE "ConversationRoutingConflict"
  ADD CONSTRAINT "ConversationRoutingConflict_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE from the conversation: a conflict has no meaning once its
-- conversation is gone, and it carries no independent financial record.
ALTER TABLE "ConversationRoutingConflict"
  ADD CONSTRAINT "ConversationRoutingConflict_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL on the resolver: deactivating an employee must not delete the audit
-- trail of decisions they made.
ALTER TABLE "ConversationRoutingConflict"
  ADD CONSTRAINT "ConversationRoutingConflict_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
