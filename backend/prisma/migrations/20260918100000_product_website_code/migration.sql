-- The design's code on the client's website. A Gati design matched to a website
-- design keeps Gati's id in "legacyId", so the website code had nowhere to live
-- and was dropped. Additive; filled by the next website import.
ALTER TABLE "Product" ADD COLUMN "websiteCode" TEXT;

-- Website-only designs already carry the code in their provenance marker.
UPDATE "Product" SET "websiteCode" = substring("legacyId" from 5)
WHERE "legacyId" LIKE 'WEB-%';

CREATE INDEX "Product_organisationId_websiteCode_idx" ON "Product" ("organisationId", "websiteCode");
