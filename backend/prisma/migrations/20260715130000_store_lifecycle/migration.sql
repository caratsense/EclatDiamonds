-- Store lifecycle: add `status` (pending | active | closed).
-- Existing rows default to 'active' (they are live branches) — correct.
ALTER TABLE "Store" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
