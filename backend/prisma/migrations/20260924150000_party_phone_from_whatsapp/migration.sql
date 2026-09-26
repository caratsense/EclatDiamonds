-- Give existing WhatsApp-originated customers their number back.
--
-- A customer created from an inbound WhatsApp message got `Party.whatsapp` set
-- and `Party.phone` left NULL, because `createPartyOwning` only filled `phone`
-- for contacts of kind 'phone'. Most screens a branch manager uses read
-- `Party.phone`, so those leads showed a name and no way to ring anybody — the
-- lead nobody calls.
--
-- The code no longer creates them that way. This repairs the ones already in
-- the table.
--
-- Safe to re-run: it only ever fills a NULL, and a WhatsApp id IS a phone
-- number, so nothing is invented. Any phone a person typed by hand wins,
-- because a non-NULL value is never touched.

UPDATE "Party"
SET "phone" = "whatsapp"
WHERE "phone" IS NULL
  AND "whatsapp" IS NOT NULL
  AND btrim("whatsapp") <> '';
