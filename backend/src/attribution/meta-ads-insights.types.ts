/**
 * The deliberately small slice of the Meta Insights response that attribution
 * consumes. The Graph client owns authentication and transport; this module
 * owns validation, persistence and reporting.
 */
export interface MetaInsightsApiRow {
  account_id?: string;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
}

export interface MetaInsightsApiPage {
  data?: MetaInsightsApiRow[];
  paging?: {
    cursors?: { after?: string };
    /**
     * Never followed directly. Its presence only says another page exists;
     * the opaque cursor is sent back through the bounded Graph client.
     */
    next?: string;
  };
}

export interface MetaInsightRecord {
  schemaVersion: 1;
  kind: 'meta_ads.daily_campaign_insight';
  integrationId: string;
  adAccountAssetId: string;
  adAccountId: string;
  externalCampaignId: string;
  campaignName: string | null;
  date: string;
  currency: string;
  timezone: string;
  spend: string;
  impressions: string | null;
  clicks: string | null;
  fetchedAt: string;
  jobId: string;
}

export interface MetaCoverageRecord {
  schemaVersion: 1;
  kind: 'meta_ads.daily_campaign_insight_coverage';
  integrationId: string;
  adAccountAssetId: string;
  adAccountId: string;
  date: string;
  currency: string;
  timezone: string;
  completedAt: string;
  jobId: string;
}

export interface MetaAdsSyncPayload {
  integrationId: string;
  adAccountAssetId: string;
  dateFrom: string;
  dateTo: string;
  requestedById: string;
}

export interface MetaAdsWindow {
  dateFrom: string;
  dateTo: string;
  dates: string[];
}

export interface MetaAdsAccountTarget {
  integrationId: string;
  integrationName: string;
  adAccountAssetId: string;
  adAccountId: string;
  currency: string;
  timezone: string;
}
