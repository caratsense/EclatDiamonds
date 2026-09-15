-- Quote discounts, and approval that is for one version of a quote.
--
-- A quote could not carry a discount at all, so a salesperson "discounted" by
-- editing making charges down and nothing noticed. The discount is now one
-- explicit percentage taken off making + diamond/stone charges (gold is never
-- discounted), judged against the existing DiscountLimit caps — the overall
-- `maxPercent` per role and store — rather than a second policy table.
--
-- Everything is additive. Every existing quote reads as undiscounted, revision 1,
-- priced by nobody, which the approval gate treats exactly as before.

ALTER TABLE "Quote" ADD COLUMN "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Whose cap applies: the person who last priced the quote. The role is frozen at
-- pricing time, because authority is judged as it was when the price was set.
-- No foreign key on purpose: removing a staff member must not rewrite who set
-- a price on a quote a customer may already hold.
ALTER TABLE "Quote" ADD COLUMN "pricedById" TEXT;
ALTER TABLE "Quote" ADD COLUMN "pricedByRole" "Role";

-- Bumped by every content edit. An approval records the revision it was for;
-- sharing refuses when they differ, so "approve, then edit, then send" fails.
ALTER TABLE "Quote" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Quote" ADD COLUMN "approvedRevision" INTEGER;
ALTER TABLE "Quote" ADD COLUMN "approvalReasons" JSONB;
ALTER TABLE "Quote" ADD COLUMN "approvalSnapshot" JSONB;
