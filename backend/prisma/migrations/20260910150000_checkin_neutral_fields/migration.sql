-- Give a visit somewhere to record what actually happened, without forcing every
-- industry through a jewellery enum.
--
-- Purely additive: four nullable columns on an existing table. No existing row
-- changes, no default is written, and rollback is four DROP COLUMNs.
--
-- WHY purposeCode EXISTS ALONGSIDE purpose: "CheckinPurpose" is an enum reading
-- bridal / investment / repair / scheme. A clinic logging an appointment and a
-- mill logging a buyer visit have no honest value to pick, and extending the
-- enum per tenant means a migration per customer. Every industry pack already
-- seeds a `checkin_purpose` taxonomy with its own labels, so purposeCode is
-- where that answer goes. The enum keeps its existing rows and its default.

ALTER TABLE "CheckIn" ADD COLUMN "purposeCode" TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "notes" TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "attendedById" TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "metadata" JSONB;

CREATE INDEX "CheckIn_attendedById_idx" ON "CheckIn"("attendedById");

-- SET NULL, not CASCADE: a staff member leaving must not delete the record that
-- a customer visited.
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_attendedById_fkey"
    FOREIGN KEY ("attendedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
