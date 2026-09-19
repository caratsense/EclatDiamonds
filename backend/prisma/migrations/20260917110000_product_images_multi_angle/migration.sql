-- Multi-angle catalogue photography.
--
-- A design used to hold exactly one picture (Product."imageUrl") and, because of
-- the unique below, exactly one visual embedding. A ring photographed front,
-- side and on the hand could therefore only ever be found from whichever single
-- view happened to be indexed last — which is why a customer's phone photo of a
-- piece failed to match the CAD render of that same piece already in the
-- catalogue. ProductImage holds the whole set; the embedding index now has one
-- row per image.

CREATE TABLE "ProductImage" (
  "id"             TEXT         NOT NULL,
  "organisationId" TEXT         NOT NULL,
  "productId"      TEXT         NOT NULL,
  "url"            TEXT         NOT NULL,
  "angle"          TEXT,
  "isPrimary"      BOOLEAN      NOT NULL DEFAULT false,
  "sortOrder"      INTEGER      NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage" ("productId", "sortOrder");
CREATE INDEX "ProductImage_organisationId_idx"      ON "ProductImage" ("organisationId");

ALTER TABLE "ProductImage"
  ADD CONSTRAINT "ProductImage_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProductImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the gallery from the cover every design already has, so nothing starts
-- empty and the existing picture keeps its place as the cover.
INSERT INTO "ProductImage" ("id", "organisationId", "productId", "url", "isPrimary", "sortOrder")
SELECT
  -- gen_random_uuid() is core since PG13; the app writes cuids, and the two
  -- never collide because nothing parses this column.
  gen_random_uuid()::TEXT,
  p."organisationId",
  p."id",
  p."imageUrl",
  true,
  0
FROM "Product" p
WHERE p."imageUrl" IS NOT NULL AND p."imageUrl" <> '';

-- The embedding index becomes per-image.
ALTER TABLE "ProductEmbedding" ADD COLUMN "productImageId" TEXT;

CREATE INDEX "ProductEmbedding_productImageId_idx" ON "ProductEmbedding" ("productImageId");

ALTER TABLE "ProductEmbedding"
  ADD CONSTRAINT "ProductEmbedding_productImageId_fkey"
    FOREIGN KEY ("productImageId") REFERENCES "ProductImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Point every existing vector at the cover row just created for its product, so
-- the index stays whole and the next re-index is a no-op rather than a rebuild.
UPDATE "ProductEmbedding" e
SET "productImageId" = i."id"
FROM "ProductImage" i
WHERE i."productId" = e."productId" AND i."isPrimary";

-- One vector per image per pipeline version, instead of one per design.
-- imageHash is already the re-index idempotency key, so identity by hash costs
-- nothing and is exactly the "is this the same picture" question.
ALTER TABLE "ProductEmbedding" DROP CONSTRAINT IF EXISTS "ProductEmbedding_productId_preprocessingVersion_key";
DROP INDEX IF EXISTS "ProductEmbedding_productId_preprocessingVersion_key";

CREATE UNIQUE INDEX "ProductEmbedding_productId_imageHash_preprocessingVersion_key"
  ON "ProductEmbedding" ("productId", "imageHash", "preprocessingVersion");
