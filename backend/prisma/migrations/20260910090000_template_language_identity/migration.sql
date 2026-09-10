-- Message templates are identified by name AND language.
--
-- Rows written before this carried the bare template name in `externalId`, and
-- `@@unique([integrationId, kind, externalId])` therefore allowed a connection
-- to hold only ONE language of a template. Recording the second language
-- rewrote the first one's row, so an approved en_US verdict silently became the
-- hi_IN row's verdict and authorised a send Meta had never reviewed.
--
-- `externalId` becomes the composite `name:language`; `name` keeps the bare
-- provider template name, which is what the Graph send call needs.
--
-- Additive and idempotent: no column is added or dropped, no row is deleted,
-- and a language is never guessed. A row with no recorded language is left
-- exactly as it is — it is not sendable until a provider sync gives it a
-- verdict anyway.

-- 1. `name` must hold the bare template name before `externalId` is rewritten.
--    Historic rows always set it, but a null would otherwise lose the name.
UPDATE "IntegrationAsset"
SET "name" = "externalId"
WHERE "kind" = 'message_template'
  AND ("name" IS NULL OR "name" = '')
  AND "externalId" NOT LIKE '%:%';

-- 2. Rewrite to the composite identity.
--    A Meta template name is lowercase [a-z0-9_], so a ':' already present can
--    only be a composite this migration wrote on an earlier run.
--    The NOT EXISTS guard keeps the unique index safe if some row already
--    occupies the composite key.
UPDATE "IntegrationAsset" AS a
SET "externalId" = a."externalId" || ':' || (a."metadata"->>'languageCode')
WHERE a."kind" = 'message_template'
  AND a."externalId" NOT LIKE '%:%'
  AND a."metadata"->>'languageCode' ~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$'
  AND NOT EXISTS (
    SELECT 1
    FROM "IntegrationAsset" AS b
    WHERE b."integrationId" = a."integrationId"
      AND b."kind" = a."kind"
      AND b."externalId" = a."externalId" || ':' || (a."metadata"->>'languageCode')
  );
