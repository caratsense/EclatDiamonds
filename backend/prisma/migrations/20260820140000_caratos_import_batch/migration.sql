-- CaratOS Phase 3 — import-engine provenance + reconciliation record.
-- Purely additive: a new ImportBatch table (organisation-scoped, NOT NULL org since
-- the import service always sets it). No existing table is altered.
-- (Two unrelated pre-existing drift DROP INDEX statements Prisma proposed were
--  excluded to keep this migration scoped.)

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "fileName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "discovered" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "duplicate" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportBatch_organisationId_createdAt_idx" ON "ImportBatch"("organisationId", "createdAt");

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
