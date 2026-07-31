-- Second attempt at removing the "branches" that were never branches.
--
-- The first one (20260731120000) ran and deleted nothing. Its guard asked "does
-- any table with a storeId column hold a row for this store?" — and the answer
-- was yes for all nine, because creating a store writes an AuditLog entry
-- carrying that store's id. So every store protected itself by existing. The
-- guard was measuring the record OF the store rather than data IN it.
--
-- The distinction that actually matters is a foreign key. A table with an FK to
-- "Store" holds rows that belong to the branch — stock, sales, staff
-- assignments; losing one would lose business data. A bare storeId column with
-- no FK (AuditLog, Notification, SyncState, Task, MetalRate …) is a reference to
-- a store, deliberately not constrained so the note survives the thing it
-- mentions. Those should not, and now do not, keep a store alive.
--
-- Reading the constraint catalog rather than listing tables by hand, for the
-- same reason as before: a model added later must be covered automatically, and
-- an FK is exactly the property being tested.
--
-- Everything else is unchanged and still deliberately narrow: only Gati-imported
-- stores (legacyId IS NOT NULL), only ones still `pending` — so no activated
-- branch is reachable from here — and any store that fails the guard is left
-- alone and named in the output for a person to look at. Nothing is lost either
-- way: these are upserted on their original id, so a sync recreates whatever
-- turns out to be real.
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
      AND status = 'pending'
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
      RAISE NOTICE 'KEPT  % (%) — holds % row(s) of real data; review by hand',
        s.name, s."legacyId", used;
    ELSE
      DELETE FROM "Store" WHERE id = s.id;
      removed := removed + 1;
      RAISE NOTICE 'REMOVED % (%)', s.name, s."legacyId";
    END IF;
  END LOOP;

  RAISE NOTICE 'Gati-imported stores: % removed, % kept (hold real data)', removed, kept;
END $$;
