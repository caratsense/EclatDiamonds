-- Payment recorder identity (2026-07-29).
--
-- A collection had no record of WHO took the money. In a cash-heavy jewellery
-- business that is the one field a collections ledger exists to carry: without
-- it, a till dispute has nothing to reconcile against and the audit trail stops
-- at "a payment of ₹50,000 was recorded at this branch".
--
-- Nullable, because rows imported by the legacy SJEP sync have no Eclat user
-- behind them and must not be blocked.
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "recordedById"   TEXT,
  ADD COLUMN IF NOT EXISTS "recordedByName" TEXT;

-- Supports "what did this person collect" without scanning the table.
CREATE INDEX IF NOT EXISTS "Payment_recordedById_paidAt_idx"
  ON "Payment" ("recordedById", "paidAt");
