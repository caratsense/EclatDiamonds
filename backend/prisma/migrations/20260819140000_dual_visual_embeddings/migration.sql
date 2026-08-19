-- Module 5 — jewelry visual similarity (DINOv3 + SigLIP 2 dual embeddings).
-- Fully additive. Portable Float[] columns so this applies on the local/preview
-- Postgres WITHOUT pgvector. The pgvector upgrade (vector(N) + HNSW cosine index
-- per column) is parked at prisma/manual/20260819_pgvector_dual_embeddings.sql and
-- run only where the `vector` extension is installed.

-- CreateEnum
CREATE TYPE "SimilarityFeedback" AS ENUM ('very_close', 'relevant', 'somewhat', 'not_relevant');

-- CreateTable
CREATE TABLE "ProductEmbedding" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storeId" TEXT,
    "dinoEmbedding" DOUBLE PRECISION[],
    "siglipEmbedding" DOUBLE PRECISION[],
    "dinoModelVersion" TEXT NOT NULL DEFAULT 'unknown',
    "siglipModelVersion" TEXT NOT NULL DEFAULT 'unknown',
    "preprocessingVersion" TEXT NOT NULL DEFAULT 'unknown',
    "imageHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimilaritySearchFeedback" (
    "id" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storeId" TEXT,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "feedback" "SimilarityFeedback" NOT NULL,
    "rankingVersion" TEXT NOT NULL,
    "modelVersions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimilaritySearchFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEmbedding_storeId_idx" ON "ProductEmbedding"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEmbedding_productId_preprocessingVersion_key" ON "ProductEmbedding"("productId", "preprocessingVersion");

-- CreateIndex
CREATE INDEX "SimilaritySearchFeedback_queryId_idx" ON "SimilaritySearchFeedback"("queryId");

-- CreateIndex
CREATE INDEX "SimilaritySearchFeedback_productId_idx" ON "SimilaritySearchFeedback"("productId");

-- AddForeignKey
ALTER TABLE "ProductEmbedding" ADD CONSTRAINT "ProductEmbedding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
