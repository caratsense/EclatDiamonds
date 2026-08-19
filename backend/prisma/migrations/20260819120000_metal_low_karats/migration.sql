-- Real karats the (lab-grown diamond) business uses: 14K/10K/9K gold. Additive.
-- Karat is read per-piece from the SKU token; these give the metal enum honest
-- low-karat buckets instead of collapsing everything to 18K/22K.
ALTER TYPE "MetalKind" ADD VALUE 'gold_14k';
ALTER TYPE "MetalKind" ADD VALUE 'gold_10k';
ALTER TYPE "MetalKind" ADD VALUE 'gold_9k';
