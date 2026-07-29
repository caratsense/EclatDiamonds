-- Welcome-guide progress, per user account.
--
-- Previously the guide remembered itself in one localStorage key shared by every
-- account on the machine: the first person to dismiss it hid it from everyone who
-- signed in on that shop tablet afterwards, and it came back from scratch for the
-- same person on a different device. Moving it onto the user row fixes both.
--
-- Guarded, matching the rest of this batch, so it is a no-op on any database that
-- already picked the columns up via `db push`.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tourViews" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tourDoneAt" TIMESTAMP(3);
