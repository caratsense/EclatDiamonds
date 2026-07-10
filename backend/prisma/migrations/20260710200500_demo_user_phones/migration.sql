-- Data migration: demo-user phone numbers for WhatsApp-OTP login testing.
-- Idempotent and narrow: only the six known demo accounts, only when phone is
-- still NULL (never overwrites a real phone). Shipped as a migration because
-- Railway's pre-deploy reliably runs `migrate deploy` (the standalone seed
-- script was not consistently executed there).

UPDATE "User" SET "phone" = '9100000001' WHERE "email" = 'head.office@caratsense.in'    AND "phone" IS NULL;
UPDATE "User" SET "phone" = '9100000002' WHERE "email" = 'neelam.area@caratsense.in'    AND "phone" IS NULL;
UPDATE "User" SET "phone" = '9100000003' WHERE "email" = 'aarav.mehta@caratsense.in'    AND "phone" IS NULL;
UPDATE "User" SET "phone" = '9100000004' WHERE "email" = 'priya.rep@caratsense.in'      AND "phone" IS NULL;
UPDATE "User" SET "phone" = '9100000005' WHERE "email" = 'karan.malhotra@caratsense.in' AND "phone" IS NULL;
UPDATE "User" SET "phone" = '9100000006' WHERE "email" = 'rina.rep@caratsense.in'       AND "phone" IS NULL;
