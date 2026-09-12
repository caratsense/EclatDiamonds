-- A customer message has to be answered within five minutes.
--
-- From the meeting: the first reply is the whole promise, and today nothing in
-- the product measures it. A thread can sit unanswered for a day and the only
-- evidence is that the inbox row is a bit further down the page.
--
-- WHAT IS ADDITIVE AND OFF
--
-- ConversationSlaSettings.firstResponseMinutes is NULL for every existing
-- tenant, and NULL means no clock is ever opened. Nothing changes anywhere
-- until somebody sets a number. Five is Éclat's number; it is deliberately not
-- a column default, because a default would switch the feature on for every
-- tenant in the database the moment this migration runs.

CREATE TABLE "ConversationSlaSettings" (
    "organisationId" TEXT NOT NULL,
    -- NULL = the SLA is not running. The default.
    "firstResponseMinutes" INTEGER,
    -- Measured from the customer's message, not from the breach, and NULL means
    -- a breach alerts the assigned employee but never climbs.
    "escalateAfterMinutes" INTEGER,
    -- No provider in this system can place an outbound call today. The flag is
    -- the recorded decision; the live-provider check is in the service.
    "autoCallOnBreach" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSlaSettings_pkey" PRIMARY KEY ("organisationId")
);

CREATE TABLE "ConversationResponseSla" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "storeId" TEXT,
    -- The inbound message that started the wait, and the idempotency key: one
    -- customer message can never open two clocks, however often the ingest path
    -- is replayed.
    "triggerMessageId" TEXT NOT NULL,
    -- Holds conversationId while the clock runs, NULL once it stops. Postgres
    -- treats NULLs as distinct in a unique index, so the constraint below is a
    -- partial-unique in disguise: at most ONE clock open per conversation, any
    -- number of finished ones. That is what makes "first response" mean the wait
    -- since the first unanswered message rather than a timer a customer can
    -- restart by sending three messages in a row.
    "openConversationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    -- Stored, not recomputed from the settings row: changing the tenant's target
    -- must not retroactively breach or un-breach threads already running.
    "dueAt" TIMESTAMP(3) NOT NULL,
    "escalateAt" TIMESTAMP(3),
    "targetMinutes" INTEGER NOT NULL,
    -- 'waiting' | 'met' | 'breached'. A thread answered after it breached stays
    -- 'breached' and still records how long the customer actually waited.
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "respondedAt" TIMESTAMP(3),
    "responderId" TEXT,
    "responderType" TEXT,
    "responseSeconds" INTEGER,
    -- Claimed by a conditional UPDATE ... WHERE breachedAt IS NULL, so the alert
    -- and the queue task happen exactly once across replicas and restarts.
    "breachedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationResponseSla_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationResponseSla_openConversationId_key"
    ON "ConversationResponseSla"("openConversationId");

CREATE UNIQUE INDEX "ConversationResponseSla_organisationId_triggerMessageId_key"
    ON "ConversationResponseSla"("organisationId", "triggerMessageId");

-- The sweep's own query: everything still owed, oldest deadline first. Not
-- scoped by organisation on purpose — the sweep is cross-tenant and the whole
-- point of the index is that it stays small, holding only rows still waiting.
CREATE INDEX "ConversationResponseSla_status_dueAt_idx"
    ON "ConversationResponseSla"("status", "dueAt");

CREATE INDEX "ConversationResponseSla_organisationId_storeId_startedAt_idx"
    ON "ConversationResponseSla"("organisationId", "storeId", "startedAt");

ALTER TABLE "ConversationSlaSettings"
    ADD CONSTRAINT "ConversationSlaSettings_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConversationResponseSla"
    ADD CONSTRAINT "ConversationResponseSla_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE: the clock is a property of the conversation. If the thread goes, the
-- measurement of how fast we answered it has nothing left to describe.
ALTER TABLE "ConversationResponseSla"
    ADD CONSTRAINT "ConversationResponseSla_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationResponseSla"
    ADD CONSTRAINT "ConversationResponseSla_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL, not CASCADE: a staff member leaving must not delete the record that
-- a customer was answered in ninety seconds. The duration is the measurement;
-- the name is only who did it.
ALTER TABLE "ConversationResponseSla"
    ADD CONSTRAINT "ConversationResponseSla_responderId_fkey"
    FOREIGN KEY ("responderId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
