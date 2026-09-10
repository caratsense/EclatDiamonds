-- INT-10. The lead-ageing SLA summary now counts every open lead of a tenant in
-- four lastActivity ranges instead of counting a capped 1,000-row page. Without
-- this index those four counts are four sequential scans of the whole table.
--
-- Additive and idempotent: creating an index changes no row and drops nothing.
CREATE INDEX IF NOT EXISTS "Lead_organisationId_outcome_lastActivity_idx"
  ON "Lead" ("organisationId", "outcome", "lastActivity");
