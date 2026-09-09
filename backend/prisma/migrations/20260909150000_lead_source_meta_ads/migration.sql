-- LeadSource.meta_ads — a lead form submitted on Facebook or Instagram.
--
-- Additive and forward-only. Nothing is renamed, reordered or removed: Postgres
-- enum values are positional and existing Lead rows reference them by that
-- position, so APPEND is the only safe operation once a table holds data.
--
-- There is deliberately NO backfill. No existing row carries deterministic
-- evidence that it came from a Meta lead ad — an `instagram` lead is the organic
-- channel and stays `instagram`. Inventing provenance to populate a new value
-- would corrupt exactly the source-mix reporting this value exists to make
-- honest.
--
-- Guarded so a re-run is a no-op: ALTER TYPE ... ADD VALUE IF NOT EXISTS is not
-- available on every supported version, so the catalogue is checked instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LeadSource' AND e.enumlabel = 'meta_ads'
  ) THEN
    ALTER TYPE "LeadSource" ADD VALUE 'meta_ads';
  END IF;
END
$$;
