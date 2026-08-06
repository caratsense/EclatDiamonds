-- Self-signup + tiered approval.
--
-- Adds the approval lifecycle to User. `approvalStatus` defaults to `approved`
-- so EVERY existing row (seed users, manager-provisioned staff, Gati-imported
-- staff) is untouched and keeps logging in exactly as before. Only rows created
-- by POST /auth/signup set `pending` and are held out of login until an
-- authorised approver (HO for managers, a store/area manager for salespeople in
-- their scope) grants the requested role + store.
--
-- `requestedRole` / `requestedStoreId` record what the signup asked for; they are
-- a request, never access — the row's real `role` stays `salesperson` and it has
-- no UserStore link until approval. Nullable + no FK on requestedStoreId on
-- purpose: a rejected/stale request must survive a store being renamed or removed.

CREATE TYPE "ApprovalStatus" AS ENUM ('approved', 'pending', 'rejected');

ALTER TABLE "User"
  ADD COLUMN "approvalStatus"   "ApprovalStatus" NOT NULL DEFAULT 'approved',
  ADD COLUMN "requestedRole"    "Role",
  ADD COLUMN "requestedStoreId" TEXT,
  ADD COLUMN "approvedById"     TEXT,
  ADD COLUMN "approvedAt"       TIMESTAMP(3);

-- The approval queue reads pending rows; index the hot filter.
CREATE INDEX "User_approvalStatus_idx" ON "User" ("approvalStatus");
