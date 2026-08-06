-- Hand-off assignee flow.
--
-- `assignedToId` links a hand-off to the real user it was passed to, so that
-- person can be notified, can see it under "assigned to me", and is the one who
-- marks it done — after which the creator approves/closes it. Nullable + additive
-- (legacy rows and free-text assignments are unaffected); the display name stays
-- in `assignedTo`. The new "closed" status is just a string value, no enum change.

ALTER TABLE "Handoff" ADD COLUMN "assignedToId" TEXT;

CREATE INDEX "Handoff_assignedToId_idx" ON "Handoff" ("assignedToId");
