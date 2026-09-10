-- Pipeline pack ownership (MM2-03).
--
-- Pipeline and PipelineStage were the only configurable rows with no `packCode`,
-- and they are the ones that MUST converge when a tenant changes industry: every
-- pack ships the same pipeline code and the same three stage codes and differs
-- only in the wording. Phase 2 worked around the gap by recording what the pack
-- wrote in Organisation.settings.packManaged. This puts the ownership beside the
-- row it describes.
--
-- Additive only: two nullable columns, two indexes, and a backfill that stamps a
-- row ONLY where the existing record proves the pack wrote it and nobody has
-- changed it since. NULL — the default for every row this migration cannot prove
-- — means tenant-owned, which is the safe reading and leaves Eclat's live funnel
-- exactly as it is.

ALTER TABLE "Pipeline" ADD COLUMN "packCode" TEXT;
ALTER TABLE "PipelineStage" ADD COLUMN "packCode" TEXT;

CREATE INDEX "Pipeline_organisationId_packCode_idx" ON "Pipeline"("organisationId", "packCode");
CREATE INDEX "PipelineStage_organisationId_packCode_idx" ON "PipelineStage"("organisationId", "packCode");

-- Backfill 1/2 — the funnel itself.
-- Stamped only when BOTH the code and the name still equal what packManaged
-- recorded. A tenant who renamed the pipeline keeps NULL and keeps ownership.
UPDATE "Pipeline" p
SET "packCode" = o."settings" -> 'packManaged' ->> 'packCode'
FROM "Organisation" o
WHERE p."organisationId" = o."id"
  AND jsonb_typeof(o."settings" -> 'packManaged' -> 'pipeline') = 'object'
  AND o."settings" -> 'packManaged' ->> 'packCode' IS NOT NULL
  AND p."code" = o."settings" -> 'packManaged' -> 'pipeline' ->> 'code'
  AND p."name" = o."settings" -> 'packManaged' -> 'pipeline' ->> 'name';

-- Backfill 2/2 — the stages.
-- Judged per stage against the recorded label for that stage code, independently
-- of the pipeline above: renaming the funnel does not hand back the stages, and
-- re-wording one stage does not forfeit the others.
UPDATE "PipelineStage" s
SET "packCode" = o."settings" -> 'packManaged' ->> 'packCode'
FROM "Organisation" o
WHERE s."organisationId" = o."id"
  AND jsonb_typeof(o."settings" -> 'packManaged' -> 'pipeline' -> 'stages') = 'object'
  AND o."settings" -> 'packManaged' ->> 'packCode' IS NOT NULL
  AND s."label" = o."settings" -> 'packManaged' -> 'pipeline' -> 'stages' ->> s."code";

-- The JSON record's `pipeline` half is now redundant, so it goes — in this same
-- transaction, and only for organisations where the columns above actually hold
-- the evidence (at least one stamped row). An organisation whose rows all drifted
-- keeps its record untouched: deleting it there would destroy the only proof that
-- those rows were ever pack-written.
--
-- `qualificationPrompts` STAYS. Question ownership still has no column of its
-- own, and dropping it would hand every tenant's reworded question back to the
-- pack on the next apply.
UPDATE "Organisation" o
SET "settings" = jsonb_set(
      o."settings",
      '{packManaged}',
      (o."settings" -> 'packManaged') - 'pipeline'
    )
WHERE jsonb_typeof(o."settings" -> 'packManaged' -> 'pipeline') = 'object'
  AND (
    EXISTS (SELECT 1 FROM "Pipeline" p WHERE p."organisationId" = o."id" AND p."packCode" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "PipelineStage" s WHERE s."organisationId" = o."id" AND s."packCode" IS NOT NULL)
  );
