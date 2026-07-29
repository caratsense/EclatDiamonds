-- Persisted notifications + branch special requests (2026-07-29).
--
-- Purely additive: three new tables and three new enums. Nothing existing is
-- altered, so this is safe to apply while the previous build is still serving.
--
-- Why persisted notifications: the bell was a set of live `count()` queries with
-- no rows behind it. That is why nothing could be cleared — there was nothing to
-- clear, only a number that fell when someone resolved the underlying record.
-- Storing the event gives each recipient their own read/dismiss state, a history
-- that outlives the source record, and something the assistant can query.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "NotificationKind" AS ENUM (
    'discount_request', 'return_request', 'leave_request', 'regularization_request',
    'special_request', 'diamond_rate_request', 'order_delayed', 'attendance_review',
    'reminder', 'system'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SpecialRequestKind" AS ENUM (
    'diamond_rate', 'price_override', 'stock_transfer', 'purchase', 'expense', 'staff', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SpecialRequestStatus" AS ENUM (
    'pending', 'escalated', 'approved', 'rejected', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Notification — one row per RECIPIENT, so read state is personal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Notification" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "storeId"     TEXT,
    "kind"        "NotificationKind" NOT NULL,
    "title"       TEXT NOT NULL,
    "body"        TEXT,
    "href"        TEXT,
    "entityType"  TEXT,
    "entityId"    TEXT,
    "priority"    TEXT NOT NULL DEFAULT 'normal',
    "actorId"     TEXT,
    "actorName"   TEXT,
    "readAt"      TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata"    JSONB,
    "dedupeKey"   TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- Idempotency for emitters that can fire twice for one event (a retry, a re-run
-- day close): re-emitting with the same key updates instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_userId_dedupeKey_key"
  ON "Notification"("userId", "dedupeKey");
CREATE INDEX IF NOT EXISTS "Notification_userId_dismissedAt_createdAt_idx"
  ON "Notification"("userId", "dismissedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx"
  ON "Notification"("userId", "readAt");
CREATE INDEX IF NOT EXISTS "Notification_entityType_entityId_idx"
  ON "Notification"("entityType", "entityId");

-- Deleting a user takes their notifications with them.
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_userId_fkey";
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. SpecialRequest — a branch asking someone above it for a DECISION.
--    Distinct from Ticket, which reports a problem to be worked and closed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SpecialRequest" (
    "id"                    TEXT NOT NULL,
    "ref"                   TEXT NOT NULL,
    "storeId"               TEXT NOT NULL,
    "kind"                  "SpecialRequestKind" NOT NULL,
    "title"                 TEXT NOT NULL,
    "details"               TEXT,
    "amount"                DECIMAL(14,2),
    "priority"              "TicketPriority" NOT NULL DEFAULT 'medium',
    "status"                "SpecialRequestStatus" NOT NULL DEFAULT 'pending',
    "neededBy"              DATE,
    "requestedById"         TEXT NOT NULL,
    "requestedByName"       TEXT,
    "requestedRole"         "Role" NOT NULL,
    "requiredRole"          "Role" NOT NULL,
    "decidedById"           TEXT,
    "decidedByName"         TEXT,
    "decidedRole"           "Role",
    "decidedAt"             TIMESTAMP(3),
    "decisionNote"          TEXT,
    "diamondSpec"           TEXT,
    "currentRatePerCarat"   DECIMAL(12,2),
    "requestedRatePerCarat" DECIMAL(12,2),
    "appliedRateId"         TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SpecialRequest_ref_key" ON "SpecialRequest"("ref");
CREATE INDEX IF NOT EXISTS "SpecialRequest_storeId_createdAt_idx"
  ON "SpecialRequest"("storeId", "createdAt");
-- The approver inbox query: everything undecided at or below my rank.
CREATE INDEX IF NOT EXISTS "SpecialRequest_status_requiredRole_idx"
  ON "SpecialRequest"("status", "requiredRole");
CREATE INDEX IF NOT EXISTS "SpecialRequest_requestedById_idx"
  ON "SpecialRequest"("requestedById");

ALTER TABLE "SpecialRequest" DROP CONSTRAINT IF EXISTS "SpecialRequest_storeId_fkey";
ALTER TABLE "SpecialRequest"
  ADD CONSTRAINT "SpecialRequest_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SpecialRequest" DROP CONSTRAINT IF EXISTS "SpecialRequest_requestedById_fkey";
ALTER TABLE "SpecialRequest"
  ADD CONSTRAINT "SpecialRequest_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. SpecialRequestMessage — the thread, so an approver can ask for context
--    without bouncing the request between statuses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SpecialRequestMessage" (
    "id"         TEXT NOT NULL,
    "requestId"  TEXT NOT NULL,
    "authorId"   TEXT,
    "authorName" TEXT,
    "body"       TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecialRequestMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SpecialRequestMessage_requestId_createdAt_idx"
  ON "SpecialRequestMessage"("requestId", "createdAt");

ALTER TABLE "SpecialRequestMessage" DROP CONSTRAINT IF EXISTS "SpecialRequestMessage_requestId_fkey";
ALTER TABLE "SpecialRequestMessage"
  ADD CONSTRAINT "SpecialRequestMessage_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "SpecialRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
