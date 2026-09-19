-- Optional ANN (pgvector HNSW) indexes for jewelry visual search, 768/768
-- (DINOv2-base + SigLIP 2 base, the models the inference service serves).
--
-- A NO-OP where pgvector is not installed (local Postgres 18 on Windows today):
-- the block checks pg_available_extensions first, and any failure inside it
-- (no privilege to CREATE EXTENSION, etc.) is caught and reported as a NOTICE,
-- so this migration can never block a deploy.
--
-- Why not the prisma/manual drafts: they add vector(1024)/vector(1152) COLUMNS
-- for DINOv3-L/SigLIP-so400m, which are not the models served, and need a
-- backfill. This adds no columns: the HNSW indexes are on an expression over the
-- existing double precision[] columns, partial to rows of exactly 768 dims, so
-- nothing about writes or the Prisma schema changes. The search queries repeat
-- the same expression and predicate (jewelry-similarity.service.ts).
--
-- Used only when SEARCH_PGVECTOR=1 AND both indexes exist (checked at boot).
-- If pgvector is installed LATER, re-run this file by hand (psql -f), since
-- Prisma records it as applied.
--
-- Down:
--   DROP INDEX IF EXISTS "ProductEmbedding_dino768_hnsw";
--   DROP INDEX IF EXISTS "ProductEmbedding_siglip768_hnsw";
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE NOTICE 'pgvector not available: visual search keeps the exact ranker';
    RETURN;
  END IF;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
    EXECUTE 'CREATE INDEX IF NOT EXISTS "ProductEmbedding_dino768_hnsw" ON "ProductEmbedding"
               USING hnsw (("dinoEmbedding"::vector(768)) vector_cosine_ops)
               WHERE array_length("dinoEmbedding", 1) = 768';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "ProductEmbedding_siglip768_hnsw" ON "ProductEmbedding"
               USING hnsw (("siglipEmbedding"::vector(768)) vector_cosine_ops)
               WHERE array_length("siglipEmbedding", 1) = 768';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector ANN indexes not created: %', SQLERRM;
  END;
END $$;
