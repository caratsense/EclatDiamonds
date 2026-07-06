-- CreateTable
CREATE TABLE "LegacyRow" (
    "id" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "legacyUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegacyRow_sourceTable_idx" ON "LegacyRow"("sourceTable");

-- CreateIndex
CREATE INDEX "LegacyRow_sourceTable_legacyUpdatedAt_idx" ON "LegacyRow"("sourceTable", "legacyUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyRow_sourceTable_rowKey_key" ON "LegacyRow"("sourceTable", "rowKey");
