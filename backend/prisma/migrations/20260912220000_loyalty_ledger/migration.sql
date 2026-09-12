-- The loyalty points ledger, and the API a tenant's own website calls.
--
-- WHY A LEDGER AND NOT A BALANCE COLUMN. A balance is a conclusion. When a
-- customer stands at the counter saying "your website told me I had 4,000
-- points", the only useful answer is the list of what happened: earned on this
-- bill, redeemed on that one, reversed because the sale was cancelled. A single
-- mutable integer cannot produce that answer and cannot be reconciled against
-- the website afterwards. So every movement is a row, `points` is SIGNED, and
-- `balanceAfter` is written in the same transaction. `LoyaltyAccount.
-- pointsBalance` is a cache of the newest entry so a lookup need not sum
-- history; where the two disagree the ledger wins.
--
-- WHY IDEMPOTENCY IS AN INDEX. The caller is somebody else's website retrying
-- over a network we do not control, and "did my redeem go through?" cannot be
-- answered by asking again — the second call would debit twice.
-- (organisationId, idempotencyKey) is UNIQUE, so a replay collides in the
-- database and the original entry is returned. Two concurrent identical
-- requests cannot both win. That is a property of the index, not of the order
-- the application happens to read in. The column is nullable and Postgres
-- treats NULLs as distinct, so movements made inside CaratOS — where there is no
-- network to retry across — are unconstrained.
--
-- WHY A REVERSAL POINTS AT ITS TARGET, UNIQUELY. Cancelling a sale must undo
-- exactly the points that sale earned, once. `reversesId` is UNIQUE, so two
-- concurrent reversals of the same earn cannot both succeed — the second gets a
-- constraint violation instead of a second credit.
--
-- All additive. No existing row is touched and nothing here runs until a tenant
-- enrols its first member.

CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    -- Linked once the customer is matched into the CRM, which is often AFTER
    -- the account exists: somebody joins on the website before they ever walk
    -- in. Never used for scoping.
    "partyId" TEXT,
    -- Digits only, normalised the way the CRM normalises a contact number. This
    -- is the website visitor's lookup key and what the counter already asks for.
    "phone" TEXT NOT NULL,
    "name" TEXT,
    -- Nullable: a website signup has no branch.
    "storeId" TEXT,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRedeemed" INTEGER NOT NULL DEFAULT 0,
    -- The tenant's own label. Never computed here: a tier threshold is a
    -- business rule the tenant owns, and one invented in code is one nobody can
    -- change.
    "tier" TEXT,
    -- 'active' | 'suspended' | 'closed'. A suspended account reads but cannot
    -- move, which is what a fraud hold actually needs.
    "status" TEXT NOT NULL DEFAULT 'active',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- One account per number per tenant. The website's "look me up by phone" has to
-- have exactly one answer, or the balance it shows is a guess.
CREATE UNIQUE INDEX "LoyaltyAccount_organisationId_phone_key"
    ON "LoyaltyAccount"("organisationId", "phone");
CREATE INDEX "LoyaltyAccount_organisationId_partyId_idx"
    ON "LoyaltyAccount"("organisationId", "partyId");
CREATE INDEX "LoyaltyAccount_organisationId_storeId_idx"
    ON "LoyaltyAccount"("organisationId", "storeId");

ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LoyaltyLedgerEntry" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    -- 'earn' | 'redeem' | 'reversal' | 'adjustment'
    "kind" TEXT NOT NULL,
    -- SIGNED: earn positive, redeem negative, reversal the exact negation of
    -- its target. Summing this column gives the balance, which is what makes
    -- the ledger auditable rather than merely stored.
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    -- The money this movement corresponds to, where there is any. Recorded for
    -- reconciliation against the tenant's own sales, never used to recompute
    -- the points.
    "amount" DECIMAL(14,2),
    "idempotencyKey" TEXT,
    "reversesId" TEXT,
    "reason" TEXT,
    -- The caller's own identifier. NOT unique: one invoice legitimately
    -- produces an earn and, later, a reversal.
    "reference" TEXT,
    "storeId" TEXT,
    -- 'website' | 'store' | 'system', so a statement can say "earned online"
    -- without guessing.
    "source" TEXT NOT NULL DEFAULT 'store',
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    -- Points also move at the counter, and the website's cached balance goes
    -- stale the moment they do. Every entry is announced to the tenant's
    -- configured endpoint, signed; these three columns record what happened to
    -- that announcement. A webhook whose failure nobody can see is worse than
    -- no webhook.
    "webhookAttempts" INTEGER NOT NULL DEFAULT 0,
    "webhookedAt" TIMESTAMP(3),
    "webhookError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- The replay guarantee. NULLs are distinct in Postgres, so this constrains
-- exactly the calls that supplied a key and nothing else.
CREATE UNIQUE INDEX "LoyaltyLedgerEntry_organisationId_idempotencyKey_key"
    ON "LoyaltyLedgerEntry"("organisationId", "idempotencyKey");
-- An entry is reversed once, enforced by the database rather than by a read.
CREATE UNIQUE INDEX "LoyaltyLedgerEntry_reversesId_key"
    ON "LoyaltyLedgerEntry"("reversesId");
CREATE INDEX "LoyaltyLedgerEntry_accountId_createdAt_idx"
    ON "LoyaltyLedgerEntry"("accountId", "createdAt");
CREATE INDEX "LoyaltyLedgerEntry_organisationId_createdAt_idx"
    ON "LoyaltyLedgerEntry"("organisationId", "createdAt");
-- The retry sweep's read: unannounced entries, oldest first.
CREATE INDEX "LoyaltyLedgerEntry_organisationId_webhookedAt_webhookAttempts_idx"
    ON "LoyaltyLedgerEntry"("organisationId", "webhookedAt", "webhookAttempts");

ALTER TABLE "LoyaltyLedgerEntry" ADD CONSTRAINT "LoyaltyLedgerEntry_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoyaltyLedgerEntry" ADD CONSTRAINT "LoyaltyLedgerEntry_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoyaltyLedgerEntry" ADD CONSTRAINT "LoyaltyLedgerEntry_reversesId_fkey"
    FOREIGN KEY ("reversesId") REFERENCES "LoyaltyLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LoyaltyLedgerEntry" ADD CONSTRAINT "LoyaltyLedgerEntry_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
