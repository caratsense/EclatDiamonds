-- What a WhatsApp number is FOR: 'internal' (staff operations) or NULL
-- (customer-facing, which is every number that exists today).
--
-- Nullable with no backfill on purpose. Writing 'customer' onto every existing
-- row would mean a migration that changes how live inbound traffic is routed,
-- and the only behaviour that needs a new value is the new internal line.
ALTER TABLE "IntegrationAsset" ADD COLUMN "purpose" TEXT;
