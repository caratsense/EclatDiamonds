-- INT-05. Provider-measured advertising spend stops living in LegacyRow.
--
-- LegacyRow is the untyped landing table the import pipeline stages raw source
-- rows in. As a home for money it fails three ways: a JSON string cannot be a
-- Decimal, nothing constrains the currency, and its only key is a composed
-- rowKey string, so the database cannot tell a replay from a second genuine
-- row. Reporting had to re-validate every blob on read and silently dropped the
-- ones that failed -- which is how a ROAS denominator shrinks unnoticed.
--
-- Additive: two new tables. No existing table is altered and nothing is
-- dropped. The historical LegacyRow blobs stay exactly where they are until
-- scripts/backfill-ad-spend.mjs copies the valid ones across and reports the
-- rest; that script is idempotent and may be re-run.

CREATE TABLE IF NOT EXISTS "AdSpendDaily" (
  "id"                 TEXT NOT NULL,
  "organisationId"     TEXT NOT NULL,
  "integrationId"      TEXT NOT NULL,
  "adAccountAssetId"   TEXT NOT NULL,
  "externalAccountId"  TEXT NOT NULL,
  "externalCampaignId" TEXT NOT NULL,
  "campaignName"       TEXT,
  "date"               DATE NOT NULL,
  "timezone"           TEXT NOT NULL,
  "currency"           TEXT NOT NULL,
  "spend"              DECIMAL(18,4) NOT NULL,
  "impressions"        BIGINT,
  "clicks"             BIGINT,
  "fetchedAt"          TIMESTAMP(3) NOT NULL,
  "jobId"              TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdSpendDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdSpendCoverage" (
  "id"                TEXT NOT NULL,
  "organisationId"    TEXT NOT NULL,
  "integrationId"     TEXT NOT NULL,
  "adAccountAssetId"  TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "date"              DATE NOT NULL,
  "timezone"          TEXT NOT NULL,
  "currency"          TEXT NOT NULL,
  "completedAt"       TIMESTAMP(3) NOT NULL,
  "jobId"             TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdSpendCoverage_pkey" PRIMARY KEY ("id")
);

-- Replay safety. One row per campaign per account-local day, so re-running a
-- window updates in place instead of double-counting spend.
CREATE UNIQUE INDEX IF NOT EXISTS "AdSpendDaily_org_asset_date_campaign_key"
  ON "AdSpendDaily" ("organisationId", "adAccountAssetId", "date", "externalCampaignId");
CREATE INDEX IF NOT EXISTS "AdSpendDaily_organisationId_adAccountAssetId_date_idx"
  ON "AdSpendDaily" ("organisationId", "adAccountAssetId", "date");
CREATE INDEX IF NOT EXISTS "AdSpendDaily_organisationId_externalCampaignId_idx"
  ON "AdSpendDaily" ("organisationId", "externalCampaignId");

CREATE UNIQUE INDEX IF NOT EXISTS "AdSpendCoverage_org_asset_date_key"
  ON "AdSpendCoverage" ("organisationId", "adAccountAssetId", "date");
CREATE INDEX IF NOT EXISTS "AdSpendCoverage_organisationId_adAccountAssetId_date_idx"
  ON "AdSpendCoverage" ("organisationId", "adAccountAssetId", "date");

-- Money invariants the application must not be the only thing enforcing.
-- Currency is ISO 4217 uppercase and nothing converts between currencies, so a
-- lowercase or three-and-a-bit code would silently split a total.
ALTER TABLE "AdSpendDaily"
  ADD CONSTRAINT "AdSpendDaily_currency_iso_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "AdSpendDaily"
  ADD CONSTRAINT "AdSpendDaily_spend_nonnegative_check" CHECK ("spend" >= 0);
ALTER TABLE "AdSpendCoverage"
  ADD CONSTRAINT "AdSpendCoverage_currency_iso_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "AdSpendDaily"
  ADD CONSTRAINT "AdSpendDaily_organisationId_fkey" FOREIGN KEY ("organisationId")
  REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdSpendDaily"
  ADD CONSTRAINT "AdSpendDaily_integrationId_fkey" FOREIGN KEY ("integrationId")
  REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdSpendCoverage"
  ADD CONSTRAINT "AdSpendCoverage_organisationId_fkey" FOREIGN KEY ("organisationId")
  REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdSpendCoverage"
  ADD CONSTRAINT "AdSpendCoverage_integrationId_fkey" FOREIGN KEY ("integrationId")
  REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
