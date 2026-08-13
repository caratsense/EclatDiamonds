-- ============================================================================
-- READY-TO-APPLY, NOT YET APPLIED. ON-SITE / INFRA REQUIRED.
-- ============================================================================
-- pgvector upgrade for Module 5 real visual similarity search.
--
-- BLOCKED: the `vector` extension is NOT available on the current dev/preview
-- Postgres (verified: `SELECT * FROM pg_available_extensions WHERE name='vector'`
-- returns 0 rows). Applying `CREATE EXTENSION vector` there errors and could
-- abort the surrounding transaction, so this migration is kept OUT of
-- prisma/migrations and is NOT run automatically. Until pgvector is installed,
-- `Product.embedding` stays `Float[]` and similarity is computed in-app
-- (rankByEmbedding). This file exists so the upgrade is a copy-paste, not a
-- rediscovery.
--
-- PRE-REQUISITE (infra, do this first on the target host):
--   * Postgres has the pgvector extension binaries installed
--     (Railway: use a pgvector-enabled Postgres image / plugin).
--   * Verify:  SELECT name FROM pg_available_extensions WHERE name = 'vector';
--
-- DIMENSION: set to your provider's output size. CLIP ViT-B/32 = 512,
-- OpenCLIP ViT-L/14 = 768, SigLIP-so400m = 1152. Pick ONE and keep it stable;
-- all stored vectors must share it. Change :DIM below before running.
--
-- HOW TO APPLY (preview first, never prod hand-edits):
--   psql "$DATABASE_URL" -v DIM=512 -f prisma/manual/20260813_pgvector_image_search.sql
-- Then regenerate embeddings:  POST /products/embeddings/reindex?force=1  (HO).
-- ============================================================================

\set DIM 512

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Additive: new typed column alongside the existing Float[] `embedding`, so the
-- app keeps working during backfill and there is no lossy in-place cast.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "embeddingVec" vector(:DIM);

-- Copy any embeddings already stored as Float[] whose length matches :DIM.
-- (array -> text -> vector is the portable cast; only same-dimension rows move.)
UPDATE "Product"
   SET "embeddingVec" = ("embedding"::text)::vector
 WHERE array_length("embedding", 1) = :DIM
   AND "embeddingVec" IS NULL;

-- ANN index for cosine distance. HNSW: better recall/latency than IVFFlat and no
-- training step. Query with the `<=>` (cosine distance) operator; similarity = 1 - distance.
CREATE INDEX IF NOT EXISTS "Product_embeddingVec_hnsw"
  ON "Product" USING hnsw ("embeddingVec" vector_cosine_ops);

COMMIT;

-- After this runs, add to prisma/schema.prisma (requires prisma preview feature
-- `postgresqlExtensions` + `Unsupported("vector(512)")` OR the prisma-vector
-- generator) and swap rankByEmbedding for an ORDER BY embeddingVec <=> $1 query:
--
--   SELECT id, sku, name, 1 - ("embeddingVec" <=> $1::vector) AS similarity
--     FROM "Product"
--    WHERE "embeddingVec" IS NOT NULL AND (<store scope>)
--    ORDER BY "embeddingVec" <=> $1::vector
--    LIMIT 24;
--
-- Then drop the Float[] `embedding` column in a follow-up migration once backfilled.
