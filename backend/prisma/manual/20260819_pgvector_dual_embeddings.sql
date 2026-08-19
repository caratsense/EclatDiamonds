-- ============================================================================
-- READY-TO-APPLY, NOT YET APPLIED. RUN ONLY WHERE pgvector IS INSTALLED.
-- ============================================================================
-- pgvector upgrade for Module 5 jewelry visual similarity (DINOv3 + SigLIP 2).
--
-- The base migration (prisma/migrations/20260819140000_dual_visual_embeddings)
-- creates "ProductEmbedding" with portable DOUBLE PRECISION[] columns so it
-- applies everywhere, including the LOCAL/preview Postgres where the `vector`
-- extension is NOT installed (verified:
--   SELECT name FROM pg_available_extensions WHERE name = 'vector';  -> 0 rows).
--
-- This file swaps those Float[] columns for real pgvector `vector(N)` columns
-- with an HNSW cosine index per column, turning the in-app O(n) scan
-- (jewelry-ranking.service.ts) into an ANN query. The application ranking code
-- gates on availability, so it keeps working before and after this runs.
--
-- PRE-REQUISITE (infra, do this first on the target host):
--   * pgvector binaries installed (Railway: pgvector-enabled Postgres image).
--   * Verify:  SELECT name FROM pg_available_extensions WHERE name = 'vector';
--
-- DIMENSIONS: set to the inference service's real output sizes. Read them from
--   GET {ML_INFERENCE_URL}/health -> { model_versions, dino_dim, siglip_dim }.
--   DINOv3 ViT-L/16 = 1024; SigLIP 2 so400m/384 = 1152. Change :DINO/:SIGLIP below.
--   All stored vectors of a column MUST share its dimension.
--
-- HOW TO APPLY (preview first, never prod hand-edits):
--   psql "$DATABASE_URL" -v DINO=1024 -v SIGLIP=1152 \
--     -f prisma/manual/20260819_pgvector_dual_embeddings.sql
-- Then regenerate embeddings:  POST /products/embeddings/reindex?force=1  (HO).
-- ============================================================================

\set DINO 1024
\set SIGLIP 1152

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Additive typed columns alongside the Float[] originals, so the app keeps
-- working during backfill and there is no lossy in-place cast.
ALTER TABLE "ProductEmbedding"
  ADD COLUMN IF NOT EXISTS "dinoVec"   vector(:DINO),
  ADD COLUMN IF NOT EXISTS "siglipVec" vector(:SIGLIP);

-- Copy existing Float[] rows whose length matches the chosen dimension.
UPDATE "ProductEmbedding"
   SET "dinoVec" = ("dinoEmbedding"::text)::vector
 WHERE array_length("dinoEmbedding", 1) = :DINO AND "dinoVec" IS NULL;

UPDATE "ProductEmbedding"
   SET "siglipVec" = ("siglipEmbedding"::text)::vector
 WHERE array_length("siglipEmbedding", 1) = :SIGLIP AND "siglipVec" IS NULL;

-- One HNSW cosine index per model. Query with `<=>` (cosine distance);
-- similarity = 1 - distance. Two-stage recall runs one ANN query per column.
CREATE INDEX IF NOT EXISTS "ProductEmbedding_dinoVec_hnsw"
  ON "ProductEmbedding" USING hnsw ("dinoVec" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "ProductEmbedding_siglipVec_hnsw"
  ON "ProductEmbedding" USING hnsw ("siglipVec" vector_cosine_ops);

COMMIT;

-- After this runs, add to schema.prisma (preview feature `postgresqlExtensions`
-- + Unsupported("vector(1024)") / Unsupported("vector(1152)")) and switch the
-- retrieval stage in jewelry-similarity.service.ts to two ANN queries:
--
--   SELECT "productId", 1 - ("dinoVec"   <=> $1::vector) AS dino_sim
--     FROM "ProductEmbedding"
--    WHERE "dinoVec" IS NOT NULL AND (<store scope>)
--    ORDER BY "dinoVec" <=> $1::vector LIMIT 50;   -- union with the siglipVec query
--
-- then feed the union into the SAME rankCandidates() fusion used by the fallback.
