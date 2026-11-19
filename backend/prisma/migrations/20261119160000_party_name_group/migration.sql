-- Names that begin with a symbol sort to the END of the directory.
--
-- A WhatsApp profile name is whatever the customer set, and a good number of
-- them are a heart, an om or a pair of folded hands. Postgres orders those
-- before every letter and digit, so the first page of the customer list was
-- emoji — the rows nobody is looking for, in front of the rows everybody is.
--
-- A generated column rather than a raw ORDER BY expression: the list query is
-- built dynamically from the filters, and rewriting it as SQL to sort it would
-- mean maintaining those filters twice. Postgres computes this on write, so
-- nothing in the application has to remember to.
ALTER TABLE "Party"
  ADD COLUMN "nameGroup" SMALLINT
  GENERATED ALWAYS AS (CASE WHEN "name" ~ '^[[:alnum:]]' THEN 0 ELSE 1 END) STORED;

-- The directory is ordered by this and then by name, on every page.
CREATE INDEX "Party_nameGroup_name_idx" ON "Party" ("organisationId", "nameGroup", "name");
