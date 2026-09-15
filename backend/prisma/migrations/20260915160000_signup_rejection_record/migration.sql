-- Self-signup rejection record: who declined a request, when, and why.
-- Additive and nullable; existing rows are untouched.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "rejectedById" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
