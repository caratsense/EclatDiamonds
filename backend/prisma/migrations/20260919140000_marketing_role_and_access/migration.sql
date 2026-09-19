-- A marketing role (one per store: CRM, marketing and inbound, own HRMS) and
-- head office's per-person access changes. Additive: the enum value is
-- appended, the column is nullable, and nobody's access changes by migrating.
--
-- Down: ALTER TABLE "User" DROP COLUMN "accessOverrides"; (an enum value cannot
-- be dropped in place; leave 'marketing' unused)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'marketing';
ALTER TABLE "User" ADD COLUMN "accessOverrides" JSONB;
