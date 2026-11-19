-- What fills a broadcast template's {{1}}, {{2}} … for each recipient.
--
-- Nullable and backfill-free: a campaign with no mapping behaves exactly as it
-- did before, and a template without variables never needs one.
ALTER TABLE "MessagingCampaign" ADD COLUMN "templateVariables" JSONB;
