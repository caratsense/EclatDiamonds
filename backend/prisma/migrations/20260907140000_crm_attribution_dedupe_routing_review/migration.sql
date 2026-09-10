-- CRM Phase 1: attribution idempotency + routing-conflict visibility.
--
-- ADDITIVE ONLY. Two nullable/defaulted columns and one unique index. No DROP,
-- no DELETE, no TRUNCATE, no type change, no new required column. Every
-- existing row reads back identically.

-- 1D — a stable identity for an ad interaction.
--
-- NULLABLE on purpose. Touches with no natural provider identity (a
-- salesperson's declared source) carry NULL and are never deduped. Postgres
-- treats NULLs as DISTINCT in a unique index, so every pre-existing row — all
-- of which are NULL here — coexists happily and no backfill is needed.
ALTER TABLE "AttributionTouch" ADD COLUMN "dedupeKey" TEXT;

-- Tenant-scoped by construction: the organisation is the first column, so one
-- tenant's click id can never collide with another's.
CREATE UNIQUE INDEX "AttributionTouch_organisationId_dedupeKey_key"
  ON "AttributionTouch" ("organisationId", "dedupeKey");

-- 1C — a later ad on an existing thread wanted a different store.
--
-- DEFAULT false with NOT NULL is safe here because the default backfills every
-- existing row in place; no row is left indeterminate and no application read
-- has to cope with a null.
ALTER TABLE "Conversation"
  ADD COLUMN "routingReviewRequired" BOOLEAN NOT NULL DEFAULT false;
