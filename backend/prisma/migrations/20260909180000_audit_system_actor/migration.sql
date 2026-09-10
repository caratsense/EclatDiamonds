-- INT-11. Some sensitive decisions have no person and no Connect agent behind
-- them: an inbound webhook placing a lead in the round-robin queue, a public QR
-- form creating one. Ownership genuinely changes hands, so the trail has to
-- record it -- but with only two actor columns the choice was to fake a human
-- actor or write nothing, and the code wrote nothing.
--
-- A third denormalised identity keeps "exactly one actor" a database invariant,
-- so a row with no actor at all remains impossible.
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "systemActorId" TEXT;

-- Replace, do not weaken. Every existing row already names exactly one of the
-- first two identities, so num_nonnulls over three columns is still 1 for all of
-- them and the new constraint validates without touching any data.
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_exactly_one_actor_check";
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_exactly_one_actor_check"
  CHECK (num_nonnulls("actorId", "machineActorId", "systemActorId") = 1);

CREATE INDEX IF NOT EXISTS "AuditLog_systemActorId_idx" ON "AuditLog"("systemActorId");
