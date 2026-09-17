-- Daily Sales Report: split the one payment column set into the two tables the
-- store actually keeps (counter sale vs customised sale), add the conversion
-- count, and record the customised-order book.
--
-- Every column is additive with a DEFAULT, so this is a metadata-only change on
-- Postgres 11+ and no existing report is rewritten. The pre-split columns
-- (cash/card/upi/oldGold*) keep their names and now mean "counter sale" — which
-- is what a jeweller's sheet already put in them.

ALTER TABLE "DailyReport"
  ADD COLUMN "conversions"     INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "bookingsOpen"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "bookingsClosed"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "customCash"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "customCard"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "customUpi"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "customGoldWtG"   DECIMAL(12,3),
  ADD COLUMN "customGoldValue" DECIMAL(14,2);
