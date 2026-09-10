-- LeadSource.imported — a lead opened from a spreadsheet or connector import.
--
-- Additive and forward-only, for the same reason as `meta_ads`: Postgres enum
-- values are positional and existing Lead rows reference them by position, so
-- APPEND is the only safe operation once the table holds data.
--
-- Why a new value rather than reusing `website` or `walk_in`.
--
-- An imported customer usually arrives with no evidence of how they originally
-- found the business. Filing those leads under any marketing channel would
-- manufacture attribution: the source-mix report would credit a channel that may
-- never have been involved, and nobody downstream could tell the invented rows
-- from the measured ones. `imported` says exactly what is known — this came out
-- of a file — and nothing more.
--
-- No backfill. Existing leads keep the source they were given.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LeadSource' AND e.enumlabel = 'imported'
  ) THEN
    ALTER TYPE "LeadSource" ADD VALUE 'imported';
  END IF;
END
$$;
