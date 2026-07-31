-- Remove the "branches" that were never branches.
--
-- The first Gati sync decided what counted as a shop by reading the
-- IsLocation / IsFactory flags on PartyMst. On this client's live data those
-- flags return supplier firms, two holding companies and a test row literally
-- called "abc" — while the party ids the STOCK actually points at are a
-- different set entirely, with zero overlap. So nine things that are not shops
-- were created as stores, and not one real shop was.
--
-- The sync agent now identifies a branch by what the data records against
-- rather than by a flag, and the backend links a Gati branch to the Eclat store
-- that already represents it. Both of those make the wrong rows above obsolete
-- rather than harmful — but they are still sitting in the store picker, and a
-- store picker offering "abc" and "APRS HO" is how someone files a sale against
-- a supplier.
--
-- Deletion is safe here precisely because these stores were never used: the
-- guard below refuses to touch any store that holds a single business row or
-- has a single user assigned. Anything that fails the guard is left in place
-- and reported, to be looked at by a person. And nothing is lost either way —
-- every one of these can be recreated by a sync, since they are upserted on
-- their original id.
--
-- Seeded stores (legacyId IS NULL) are untouched; they are handled at go-live
-- by the purge, which is a separate and deliberately-confirmed operation.
DO $$
DECLARE
  s            RECORD;
  col          RECORD;
  n            BIGINT;
  used         BIGINT;
  removed      INT := 0;
  kept         INT := 0;
BEGIN
  FOR s IN
    SELECT id, name, "legacyId" FROM "Store"
    WHERE "legacyId" IS NOT NULL
      AND "isAggregate" = false
      -- Auto-detected and never set up. An activated branch is out of reach of
      -- this migration no matter what else is true of it.
      AND status = 'pending'
    ORDER BY name
  LOOP
    used := 0;

    -- Every table that carries a storeId, discovered rather than listed, so a
    -- model added since this was written cannot quietly fall out of the check.
    FOR col IN
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND c.column_name = 'storeId'
        AND t.table_type = 'BASE TABLE'
    LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE "storeId" = $1', col.table_name)
        INTO n USING s.id;
      used := used + n;
      EXIT WHEN used > 0;
    END LOOP;

    IF used > 0 THEN
      kept := kept + 1;
      RAISE NOTICE 'KEPT  % (%) — holds % row(s); review by hand', s.name, s."legacyId", used;
    ELSE
      DELETE FROM "Store" WHERE id = s.id;
      removed := removed + 1;
      RAISE NOTICE 'REMOVED % (%)', s.name, s."legacyId";
    END IF;
  END LOOP;

  RAISE NOTICE 'Gati-imported stores: % removed, % kept (in use)', removed, kept;
END $$;
