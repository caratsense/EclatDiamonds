-- Connect agents are deliberately not Users. Preserve their sensitive sync
-- actions without inventing a human FK, and require every audit row to name
-- exactly one durable actor identity.
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "AuditLog" ADD COLUMN "machineActorId" TEXT;

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_exactly_one_actor_check"
  CHECK (num_nonnulls("actorId", "machineActorId") = 1);

CREATE INDEX "AuditLog_machineActorId_idx" ON "AuditLog"("machineActorId");
