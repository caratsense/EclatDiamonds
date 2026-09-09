-- Retain the exact server-issued Connect configuration generation under which
-- each machine receipt was accepted. Nullable keeps every historical and human
-- file import valid without inventing provenance.

ALTER TABLE "ImportBatch"
  ADD COLUMN "configRevision" TEXT;
