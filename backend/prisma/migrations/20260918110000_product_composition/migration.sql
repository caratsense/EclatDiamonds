-- What a design is made of (metal, diamonds, stones, making), from Gati's
-- StyleMstSummary or the website's billOfMaterial. Additive; filled by the
-- next sync of either.
ALTER TABLE "Product" ADD COLUMN "composition" JSONB;
