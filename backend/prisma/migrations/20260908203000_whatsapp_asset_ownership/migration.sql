-- A WhatsApp phone_number_id is an inbound routing identity, not merely display
-- metadata. Exactly one active tenant Integration may own it. Abort loudly on
-- historical ambiguity/corruption; migration must never guess, delete or merge.
DO $$
BEGIN
  IF EXISTS (
    SELECT ia."externalId"
    FROM "IntegrationAsset" ia
    JOIN "Integration" i ON i."id" = ia."integrationId"
    WHERE i."providerCode" = 'whatsapp_cloud'
      AND ia."kind" = 'phone_number'
      AND ia."isActive" = TRUE
    GROUP BY ia."externalId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce WhatsApp phone-number ownership: duplicate active phone_number IDs exist. Resolve them explicitly before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "IntegrationAsset" ia
    JOIN "Integration" i ON i."id" = ia."integrationId"
    WHERE i."providerCode" = 'whatsapp_cloud'
      AND ia."kind" = 'phone_number'
      AND ia."isActive" = TRUE
      AND ia."organisationId" <> i."organisationId"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce WhatsApp phone-number ownership: an active asset tenant does not match its parent Integration. Repair it explicitly before retrying.';
  END IF;
END $$;

ALTER TABLE "IntegrationAsset" ADD COLUMN "ownershipKey" TEXT;

UPDATE "IntegrationAsset" ia
SET "ownershipKey" = 'whatsapp_cloud:phone_number:' || ia."externalId"
FROM "Integration" i
WHERE i."id" = ia."integrationId"
  AND i."providerCode" = 'whatsapp_cloud'
  AND ia."kind" = 'phone_number'
  AND ia."isActive" = TRUE;

CREATE UNIQUE INDEX "IntegrationAsset_ownershipKey_key"
  ON "IntegrationAsset"("ownershipKey");

