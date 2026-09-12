-- Which number does this branch send from.
--
-- THE PROBLEM, CONCRETELY. A business with eight WhatsApp numbers across two
-- WABA accounts had exactly one sender: the resolver read the tenant's
-- phone-number assets ordered by creation date and took the FIRST. Every branch
-- therefore sent from whichever number was registered first, and a customer who
-- wrote to the Surat shop was answered from the Mumbai one. The registry made
-- it worse by design — registering a new number deactivated every other one,
-- because "exactly one active sender per connection" was a deliberate
-- simplification. That simplification is now the blocker, and the code that
-- enforced it is lifted alongside this table.
--
-- WHY A ROUTE TABLE AND NOT A COLUMN ON Store. A column answers the question
-- for WhatsApp and then needs a second for Instagram and a third for SMS. More
-- to the point, a column cannot express what has to be true: one number may
-- serve several branches (a head-office line answering for three shops), and a
-- branch may legitimately have none of its own. A row per (branch, channel)
-- says exactly that, and its ABSENCE is a meaningful state rather than a null
-- somebody has to interpret.
--
-- WHY THE CONVERSATION REMEMBERS ITS NUMBER. `Conversation.senderAssetId` is
-- the number a thread arrived on, and it outranks the branch route when a reply
-- goes out. Replying from a different number starts a second thread on the
-- customer's phone, abandons the 24-hour customer-care window opened on the
-- first, and reads to them as a different business.
--
-- Both additive. Every existing tenant keeps working: with no routes and one
-- number, resolution is unambiguous and behaves exactly as before. With SEVERAL
-- numbers and no route it now REFUSES to send and says which branches need
-- mapping — which is the correct direction to fail, because the previous
-- behaviour was to send as the wrong branch and say nothing.

CREATE TABLE "StoreMessagingRoute" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    -- Kept as a string for the same reason Conversation.channel is: adding a
    -- channel must not require an enum migration before a tenant can be routed.
    "channel" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    -- The provider identity this branch sends from.
    "assetId" TEXT NOT NULL,
    -- For the conversation that starts "why is Surat sending from the Mumbai
    -- number".
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreMessagingRoute_pkey" PRIMARY KEY ("id")
);

-- One sender per branch per channel. Two would be a coin toss at send time.
CREATE UNIQUE INDEX "StoreMessagingRoute_storeId_channel_key"
    ON "StoreMessagingRoute"("storeId", "channel");
CREATE INDEX "StoreMessagingRoute_organisationId_channel_idx"
    ON "StoreMessagingRoute"("organisationId", "channel");
CREATE INDEX "StoreMessagingRoute_assetId_idx" ON "StoreMessagingRoute"("assetId");

ALTER TABLE "StoreMessagingRoute" ADD CONSTRAINT "StoreMessagingRoute_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreMessagingRoute" ADD CONSTRAINT "StoreMessagingRoute_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE on both: a route cannot outlive the connection or the asset it
-- depends on. A dangling route would resolve to a number the tenant no longer
-- holds, which is worse than no route at all — no route refuses and says so.
ALTER TABLE "StoreMessagingRoute" ADD CONSTRAINT "StoreMessagingRoute_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreMessagingRoute" ADD CONSTRAINT "StoreMessagingRoute_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "IntegrationAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The number a thread arrived on, and the one its replies must leave from.
-- Nullable: threads that predate this, and threads started from inside CaratOS,
-- fall back to the branch route.
ALTER TABLE "Conversation" ADD COLUMN "senderAssetId" TEXT;

CREATE INDEX "Conversation_senderAssetId_idx" ON "Conversation"("senderAssetId");

-- SET NULL, not CASCADE: removing a number must not delete the conversations
-- held on it. The thread survives and falls back to the branch route, which is
-- what a tenant who retires a number actually wants.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_senderAssetId_fkey"
    FOREIGN KEY ("senderAssetId") REFERENCES "IntegrationAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
