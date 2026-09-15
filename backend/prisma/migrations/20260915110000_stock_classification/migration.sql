-- What kind of stock a design or a piece is (Block 9).
--
-- Dead stock treated every piece on the shelf as merchandise. A ring made for
-- one customer and a display sample are not: the first is not the shop's to
-- offer to the next person, the second is not for sale at all, and telling a
-- manager to discount either is advice that loses a customer or a showpiece.
--
-- The design carries a classification (importable), and a piece may override it
-- (NULL = inherit), because one piece made to order on a standard design must be
-- markable without reclassifying its siblings.
--
-- `remakeSuitable` is set by a person, never inferred.
--
-- All additive with defaults: every existing design is `standard` and every
-- existing piece inherits it, so nothing moves on deploy.

CREATE TYPE "StockClass" AS ENUM ('standard', 'customised', 'non_stock');

ALTER TABLE "Product" ADD COLUMN "stockClass" "StockClass" NOT NULL DEFAULT 'standard';

ALTER TABLE "StockItem" ADD COLUMN "stockClass" "StockClass";
ALTER TABLE "StockItem" ADD COLUMN "remakeSuitable" BOOLEAN NOT NULL DEFAULT false;
