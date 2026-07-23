-- Remove AI-generated placeholder brand names from gold-savings scheme plans.
--
-- The client never supplied brand names ("Swarna 11+1", "Swarna Plus 11+2",
-- "Deergha 24+3") — they were invented during early UI scaffolding. Module 17's
-- gold-savings scheme is DEFERRED ("LATER") per the client discovery call, so the
-- plans stay as neutral, self-describing placeholders until the client activates
-- the real scheme and Head Office names it from the admin.
--
-- The seed file was already corrected, but seeds do not re-run on deploy — only
-- migrations do — so the live rows kept the old names. Matching on the name (not
-- the id) so any environment seeded at any point gets cleaned.

UPDATE "SchemePlan" SET "name" = '11+1 Gold Scheme'
 WHERE "name" ILIKE 'Swarna 11+1%';

UPDATE "SchemePlan" SET "name" = '11+2 Gold Scheme'
 WHERE "name" ILIKE 'Swarna Plus 11+2%' OR "name" ILIKE 'Swarna 11+2%';

UPDATE "SchemePlan" SET "name" = '24+3 Gold Scheme'
 WHERE "name" ILIKE 'Deergha%';

-- Catch-all: any other row still carrying an invented brand name falls back to a
-- generic, tenure-derived label so nothing branded survives.
UPDATE "SchemePlan"
   SET "name" = CONCAT("tenureMonths", '+', "bonusMonths", ' Gold Scheme')
 WHERE "name" ILIKE '%Swarna%' OR "name" ILIKE '%Deergha%';

-- Same treatment for the demo referral row: "Earn with Éclat" is the program
-- name; the old placeholder referrer/code carried a name the client never gave.
-- Guarded so it cannot collide with an existing ECLAT-DEMO code.
UPDATE "ReferralCode" SET "referrerName" = 'Demo Referrer'
 WHERE "referrerName" ILIKE '%Ratanlall%';

UPDATE "ReferralCode" SET "code" = 'ECLAT-DEMO'
 WHERE "code" = 'RATAN-DEMO'
   AND NOT EXISTS (SELECT 1 FROM "ReferralCode" WHERE "code" = 'ECLAT-DEMO');
