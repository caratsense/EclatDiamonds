-- A quote a manager has to sign off before it leaves the building.
--
-- From the meeting: "the final quotation amount will be approved by a manager".
-- Today `share()` has exactly one guard — that the quote has a phone number —
-- so any amount can be WhatsApped to a customer by anybody who can open the
-- screen.
--
-- THE THRESHOLD IS ON THE AMOUNT, NOT ON A DISCOUNT PERCENTAGE. Discount caps
-- already live in DiscountLimit, per role and per store. Duplicating them here
-- would create a second answer to the same question, and the first thing that
-- drifts is the copy nobody can see. This gate answers a different question: is
-- this quote large enough that somebody senior should look at it first.
--
-- Everything here is additive and defaults to OFF. A tenant with no threshold
-- configured behaves exactly as it does today, which is what makes this safe to
-- deploy ahead of anybody deciding what their number should be.

-- Appended, never inserted. Postgres enum values are positional and existing
-- rows reference them by position; adding these in the middle would silently
-- re-label every quote already in the table.
ALTER TYPE "QuoteStatus" ADD VALUE IF NOT EXISTS 'pending_approval';
ALTER TYPE "QuoteStatus" ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE "QuoteStatus" ADD VALUE IF NOT EXISTS 'rejected';

ALTER TABLE "Quote" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "Quote" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN "decidedById" TEXT;
ALTER TABLE "Quote" ADD COLUMN "decidedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN "decisionReason" TEXT;

-- The amount that was actually approved, frozen at the moment of the decision.
--
-- Sharing compares the CURRENT grand total against this and refuses when they
-- differ. Without it a quote approved at one price could be edited downward and
-- sent, and the approval would be decoration.
ALTER TABLE "Quote" ADD COLUMN "approvedTotal" DECIMAL(14,2);

CREATE TABLE "QuoteApprovalSettings" (
    "organisationId" TEXT NOT NULL,
    -- NULL = approval is never required. The default, so nothing changes for an
    -- existing tenant until somebody deliberately sets a number.
    "valueThreshold" DECIMAL(14,2),
    -- False by default: separation is the entire point of an approval step.
    "allowSelfApproval" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteApprovalSettings_pkey" PRIMARY KEY ("organisationId")
);

CREATE INDEX "Quote_organisationId_status_idx" ON "Quote"("organisationId", "status");

ALTER TABLE "QuoteApprovalSettings"
    ADD CONSTRAINT "QuoteApprovalSettings_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL on both: removing a staff member must not erase the record that a
-- quote was approved, only the name attached to it. The timestamp and the
-- amount snapshot are the parts that carry the decision.
ALTER TABLE "Quote"
    ADD CONSTRAINT "Quote_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Quote"
    ADD CONSTRAINT "Quote_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
