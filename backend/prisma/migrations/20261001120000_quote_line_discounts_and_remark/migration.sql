-- A discount on each line of a quote, the way the shop's bill prints it, and a
-- free-text remark per item.
--
-- All three are nullable with no default and no backfill. NULL on the two
-- percentages means "use the quote's own making %", which is exactly how every
-- existing quote was priced, so no stored total changes.
ALTER TABLE "QuoteLine" ADD COLUMN "metalDiscountPercent" DECIMAL(5,2);
ALTER TABLE "QuoteLine" ADD COLUMN "makingDiscountPercent" DECIMAL(5,2);
ALTER TABLE "QuoteLine" ADD COLUMN "remark" TEXT;
