-- ONE SESSION PER PERSON PER BOT.
--
-- The row was unique on phoneE164 alone, so the two bots shared it. A store
-- manager halfway through a daily report who then wrote to the shopfront
-- number had the report silently overwritten by a fresh customer session --
-- measured, with walkIns and seriousEnquiries already collected and gone after
-- one message to the other line.
--
-- Existing rows become 'staff'. That is what every one of them is: until the
-- customer bot had a second line to run on, a session belonged to the staff
-- flow unless `flow` said 'customer', and the backfill below corrects those.
ALTER TABLE "WhatsAppSession" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'staff';

UPDATE "WhatsAppSession" SET "kind" = 'customer' WHERE "flow" = 'customer';

-- A person could hold a live row for each bot only AFTER this index exists, so
-- there is nothing to deduplicate: today's data has at most one row per phone.
DROP INDEX IF EXISTS "WhatsAppSession_phoneE164_key";
CREATE UNIQUE INDEX "WhatsAppSession_phoneE164_kind_key"
  ON "WhatsAppSession"("phoneE164", "kind");
