-- Google sign-in now matches on Google's `sub` instead of the email, since emails
-- get recycled and the new owner would inherit the old user's role and stores.
-- Nullable + unique, so no backfill: accounts link on their next Google sign-in.

ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;

CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
