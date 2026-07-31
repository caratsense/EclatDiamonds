-- Designs belong to the company, not to one shop.
--
-- Imported designs were previously stamped with the sync's default store, which
-- made them invisible to every OTHER branch: the catalogue query matches
-- `storeId = <viewer> OR storeId IS NULL`, so 892 designs sitting on
-- `surat-main` could not be seen from Bandra, Delhi or anywhere else. A
-- salesperson opening the catalogue saw almost nothing.
--
-- `Product.storeId IS NULL` is the schema's way of saying "the whole company
-- sells this", which is exactly right for a design book. Whether a design can be
-- SOLD today is a different question, answered per branch from actual stock
-- (ProductsService.stockPresence) rather than from ownership.
--
-- Scoped to imported rows only (`legacyId IS NOT NULL`). A product created by
-- hand inside Eclat for one branch keeps its owner — that was a deliberate
-- choice by a human, not an artefact of the importer.
UPDATE "Product"
SET "storeId" = NULL
WHERE "legacyId" IS NOT NULL
  AND "storeId" IS NOT NULL;
