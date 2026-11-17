-- Re-read the product group of pieces and designs already stored as 'other'.
--
-- `categoryFromCode` committed to the first field that was PRESENT rather than
-- the first that was READABLE, so Inward rows were classified from `JewelCode`
-- -- an inward serial (`A01225`) on this install, not a design code. 996 of
-- 1,428 pieces in production (70%) were filed under 'other' while their own SKU
-- read `APD00004`, `30059ER`, `12037ARG`, `10954NK`. Picking Rings returned 177
-- of the pieces that are rings, which is what "the filters are not working"
-- was. The sync is fixed; this repairs what is already stored.
--
-- A migration rather than a script because the sync is incremental: the agent
-- sends rows whose legacy watermark has advanced, so a piece nobody edits in
-- Gati is never sent again and would keep its wrong category indefinitely.
-- This runs once, on deploy, through the preDeployCommand that already runs
-- `prisma migrate deploy`.
--
-- Gati puts the group in the last two letters of the leading token:
--   10880RG -> RG, SDNK01033 -> NK, 12037ARG -> RG (design 12037, variant A).
-- Mirrors CODE_GROUP and groupFromToken in src/sync/sync.util.ts.
--
-- Only ever moves a row TO a recognised group. Rows already categorised are
-- untouched, and a code naming no group stays 'other' rather than being
-- guessed at -- so re-running this is a no-op and nothing is ever destroyed.

CREATE TEMPORARY TABLE _code_group (code text PRIMARY KEY, cat "ProductCategory") ON COMMIT DROP;
INSERT INTO _code_group (code, cat) VALUES
  ('RG', 'ring'),
  ('PD', 'pendant'),
  ('BG', 'bangle'),
  ('BR', 'bracelet'),
  ('NK', 'necklace'),
  ('ER', 'earrings'),
  ('CH', 'chain'),
  ('CG', 'chain');

-- The two stored columns that can carry the code. `sku` is Gati's InwardSKUNo
-- and is the one the old order skipped; `styleNumber` is the linked design's
-- code and covers pieces whose own SKU is only a serial.
--
-- Two passes rather than COALESCE(sku, styleNumber): a `sku` that is present
-- but carries no group must fall through to `styleNumber`, which is exactly the
-- "present, not readable" mistake being fixed here.

UPDATE "StockItem" s
SET category = g.cat
FROM _code_group g
WHERE s.category = 'other'
  AND upper(right(regexp_replace(split_part(s.sku, '-', 1), '[^A-Za-z]', '', 'g'), 2)) = g.code;

UPDATE "StockItem" s
SET category = g.cat
FROM _code_group g
WHERE s.category = 'other'
  AND upper(right(regexp_replace(split_part(s."styleNumber", '-', 1), '[^A-Za-z]', '', 'g'), 2)) = g.code;

-- Designs too. Products carry a real StyleCode so only ~11% were affected, but
-- the same fall-through applies and the catalogue filters read this column.

UPDATE "Product" p
SET category = g.cat
FROM _code_group g
WHERE p.category = 'other'
  AND upper(right(regexp_replace(split_part(p."styleNumber", '-', 1), '[^A-Za-z]', '', 'g'), 2)) = g.code;

UPDATE "Product" p
SET category = g.cat
FROM _code_group g
WHERE p.category = 'other'
  AND upper(right(regexp_replace(split_part(p.sku, '-', 1), '[^A-Za-z]', '', 'g'), 2)) = g.code;
