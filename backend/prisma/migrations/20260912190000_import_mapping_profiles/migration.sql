-- A column mapping somebody already worked out once.
--
-- The import pipeline already maps any spreadsheet onto canonical fields, but
-- the mapping was re-done by hand on every upload. A supplier file arrives every
-- month with the same forty columns; re-mapping it monthly is where the mistake
-- creeps in — the column that was "Cost" is "Cost Price" this month and nobody
-- notices it landed in `price`.
--
-- `sourceHeaders` is the header row the profile was built from. Applying a
-- profile to a file whose columns have changed then REPORTS what moved, instead
-- of quietly mapping the wrong column. That is the whole reason this is a table
-- and not a blob of JSON in a settings row.
--
-- Additive and inert: no tenant has a profile until somebody saves one, and
-- every existing import path keeps working unchanged.

CREATE TABLE "ImportMappingProfile" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- A profile is valid only for the entity it was built against: the canonical
    -- fields differ, so a customers profile applied to products is nonsense.
    "entity" TEXT NOT NULL,
    -- [{ sourceColumn, canonicalField }] — exactly the shape the import
    -- endpoints already accept, so a saved profile is replayed, not translated.
    "mappings" JSONB NOT NULL,
    "sourceHeaders" TEXT[],
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportMappingProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportMappingProfile_organisationId_entity_name_key"
    ON "ImportMappingProfile"("organisationId", "entity", "name");

CREATE INDEX "ImportMappingProfile_organisationId_entity_idx"
    ON "ImportMappingProfile"("organisationId", "entity");

ALTER TABLE "ImportMappingProfile"
    ADD CONSTRAINT "ImportMappingProfile_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
