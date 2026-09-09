-- Profile-driven Connect agent safety and neutral master-data support.
-- Additive. Historical Party codes are intentionally left untouched; only the
-- server-enforced connector namespaces become unique, without choosing or
-- merging legacy customer records.

ALTER TYPE "MetalKind" ADD VALUE IF NOT EXISTS 'unspecified';

ALTER TABLE "ImportBatch"
  ADD COLUMN "runKey" TEXT,
  ADD COLUMN "profileId" TEXT,
  ADD COLUMN "profileHash" TEXT,
  ADD COLUMN "payloadHash" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Product"
  ADD COLUMN "categoryLabel" TEXT,
  ADD COLUMN "materialLabel" TEXT,
  ADD COLUMN "unitOfMeasure" TEXT,
  ADD COLUMN "weightKnown" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "priceKnown" BOOLEAN NOT NULL DEFAULT false;

-- A historical zero was the application's placeholder, not evidence that the
-- source explicitly supplied zero. Preserve trustworthy non-zero values, then
-- restore the normal default for newly hand-created products.
UPDATE "Product"
SET "weightKnown" = ("weightGrams" <> 0),
    "priceKnown" = ("price" <> 0);

ALTER TABLE "Product"
  ALTER COLUMN "weightKnown" SET DEFAULT true,
  ALTER COLUMN "priceKnown" SET DEFAULT true;

CREATE UNIQUE INDEX "ImportBatch_organisationId_sourceSystem_entity_runKey_key"
  ON "ImportBatch"("organisationId", "sourceSystem", "entity", "runKey");

-- Legacy tenants may contain repeated historical party codes. Connector IDs are
-- separately namespaced and server-enforced, so uniqueness can be made strict
-- for new machine identities without inventing a winner among legacy records.
CREATE UNIQUE INDEX "Party_connect_source_code_key"
  ON "Party"("organisationId", "code")
  WHERE "code" ~ '^(busy|tally|odbc|gati):[a-f0-9]{32}:.+$';
