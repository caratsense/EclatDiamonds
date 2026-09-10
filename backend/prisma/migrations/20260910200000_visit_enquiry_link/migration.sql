-- Which visit an item-interest belongs to.
--
-- A visit records what the customer asked about as ProductInteraction rows, but
-- until now nothing tied those rows back to the visit itself. Reading them back
-- meant matching on partyId + storeId + a time window, which is a guess: two
-- visits by the same customer on the same day, or two customers at one counter,
-- and the guess attaches one person's enquiries to another person's visit.
--
-- Nullable on purpose, and NOT backfilled. Interest is also shown over WhatsApp
-- and on the website where there is no visit at all, and the rows written before
-- this column existed have no visit to point at. A backfill would have to invent
-- the very association this column exists to stop being invented.
ALTER TABLE "ProductInteraction" ADD COLUMN "checkInId" TEXT;

CREATE INDEX "ProductInteraction_organisationId_checkInId_idx"
  ON "ProductInteraction"("organisationId", "checkInId");

-- SET NULL, not CASCADE: deleting a visit must not delete the record that the
-- customer was interested in something.
ALTER TABLE "ProductInteraction"
  ADD CONSTRAINT "ProductInteraction_checkInId_fkey"
  FOREIGN KEY ("checkInId") REFERENCES "CheckIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
