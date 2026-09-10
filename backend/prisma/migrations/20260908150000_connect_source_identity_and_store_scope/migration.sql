-- Bind every Connect agent to one reviewed source connection descriptor and retain the
-- effective branch target on every import receipt. Both columns are nullable so
-- historical human imports remain valid without inventing attribution.

ALTER TABLE "ConnectAgent"
  ADD COLUMN "sourceInstanceHash" TEXT;

ALTER TABLE "ImportBatch"
  ADD COLUMN "targetStoreId" TEXT,
  ADD COLUMN "sourceInstanceHash" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "ImportBatch_organisationId_targetStoreId_createdAt_idx"
  ON "ImportBatch"("organisationId", "targetStoreId", "createdAt");

ALTER TABLE "ImportBatch"
  ADD CONSTRAINT "ImportBatch_targetStoreId_fkey"
  FOREIGN KEY ("targetStoreId") REFERENCES "Store"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
