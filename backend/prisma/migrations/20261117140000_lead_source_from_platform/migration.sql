-- File existing ad leads under the platform they were actually clicked on.
--
-- Lead.source was hardcoded 'whatsapp' on every automatic path. That is true of
-- the channel the customer wrote on and says nothing about where they clicked,
-- so all 107 leads in production read "WhatsApp" -- not one under Instagram or
-- Meta Ads -- while the conversations behind them split roughly 30 Facebook to
-- 14 Instagram. Filtering the pipeline by Instagram returned nothing, and the
-- honest reading of that screen was that no advert had ever produced a lead.
--
-- The code is fixed for new leads; this re-files the ones already stored, or
-- the filter stays empty for everything that happened before today.
--
-- The join is the lead's own originKey, which the creating code builds as
-- 'click:<sourceClickId>' when the provider gave a click id and 'convo:<id>'
-- otherwise. No guessing: a lead is only moved when its originating
-- conversation names a platform.
--
-- Deliberately narrow:
--   * only leads currently sitting on 'whatsapp' -- a walk-in, a phone
--     enquiry, a referral or an import is never touched;
--   * only where the conversation has a non-null sourcePlatform, so an organic
--     WhatsApp enquiry correctly stays 'whatsapp';
--   * 'facebook' and 'messenger' become 'meta_ads' because LeadSource has no
--     'facebook' member.
-- Re-running changes nothing, because the rows no longer match 'whatsapp'.

UPDATE "Lead" l
SET source = 'instagram'
FROM "Conversation" c
WHERE l.source = 'whatsapp'
  AND c."sourcePlatform" = 'instagram'
  AND l."originKey" IS NOT NULL
  AND l."originKey" IN ('click:' || c."sourceClickId", 'convo:' || c.id);

UPDATE "Lead" l
SET source = 'meta_ads'
FROM "Conversation" c
WHERE l.source = 'whatsapp'
  AND c."sourcePlatform" IN ('facebook', 'messenger')
  AND l."originKey" IS NOT NULL
  AND l."originKey" IN ('click:' || c."sourceClickId", 'convo:' || c.id);
