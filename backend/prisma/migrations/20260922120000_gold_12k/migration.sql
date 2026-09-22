-- 12K gold (500 fineness): the business quotes in 9, 12, 14, 18, 22 and 24K.
-- Additive; its daily rate is derived from IBJA's 999 like 10K and 9K.
--
-- Down: an enum value cannot be dropped in place; leave 'gold_12k' unused.
ALTER TYPE "MetalKind" ADD VALUE IF NOT EXISTS 'gold_12k';
