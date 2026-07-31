-- Remove closed Gati-imported stores that hold nothing.
--
-- The previous migration only considered `pending` stores, deliberately: an
-- activated branch must be out of reach. But that also spared a store left
-- behind by our own test suite, `[test] Gati Branch` (legacyId TEST-LOC-9999),
-- which had been soft-closed rather than deleted. Closed stores still appear in
-- the head-office store list, and a client opening it a day before go-live
-- should not be reading our test fixtures.
--
-- `closed` is safe to include for the same reason `pending` was: neither is a
-- branch anyone is trading from. `active` remains untouchable. The FK guard is
-- unchanged — a store holding any row that belongs to it is kept and named.
DO $$
DECLARE
  s        RECORD;
  col      RECORD;
  n        BIGINT;
  used     BIGINT;
  removed  INT := 0;
  kept     INT := 0;
BEGIN
  FOR s IN
    SELECT id, name, "legacyId" FROM "Store"
    WHERE "legacyId" IS NOT NULL
      AND "isAggregate" = false
      AND status IN ('pending', 'closed')
    ORDER BY name
  LOOP
    used := 0;

    FOR col IN
      SELECT DISTINCT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = current_schema()
        AND ccu.table_name = 'Store'
    LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', col.table_name, col.column_name)
        INTO n USING s.id;
      used := used + n;
      EXIT WHEN used > 0;
    END LOOP;

    IF used > 0 THEN
      kept := kept + 1;
      RAISE NOTICE 'KEPT  % (%) — holds % row(s) of real data', s.name, s."legacyId", used;
    ELSE
      DELETE FROM "Store" WHERE id = s.id;
      removed := removed + 1;
      RAISE NOTICE 'REMOVED % (%)', s.name, s."legacyId";
    END IF;
  END LOOP;

  RAISE NOTICE 'Empty pending/closed Gati stores: % removed, % kept', removed, kept;
END $$;
