-- A non-hierarchical inventory role. Appended: Postgres enum values are
-- positional and existing rows reference them, so nothing is reordered and no
-- existing user changes role.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'storeperson';
