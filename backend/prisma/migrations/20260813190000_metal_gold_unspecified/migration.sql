-- Karat honesty (Module 9 sync): a gold piece whose purity is not known from the
-- legacy source is mapped to `gold_unspecified` (karat left null) instead of a
-- false default of 22K. Fully additive.
ALTER TYPE "MetalKind" ADD VALUE 'gold_unspecified';
