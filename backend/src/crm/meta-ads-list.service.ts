import { Injectable, Logger } from '@nestjs/common';

import { META_ADS_PROVIDER_CODE } from '../integrations/meta-asset-ownership.service';
import { MetaGraphClient } from '../integrations/meta-graph.client';
import { PrismaService } from '../prisma/prisma.service';

export interface MetaAdChoice {
  id: string;
  name: string;
  status: string;
}

export interface MetaCampaignChoice {
  id: string;
  name: string;
  status: string;
  ads: MetaAdChoice[];
}

export interface MetaAdsListing {
  available: boolean;
  /** Why the picker cannot be offered. Null whenever `available` is true. */
  reason: string | null;
  campaigns: MetaCampaignChoice[];
}

interface CacheEntry {
  value: MetaAdsListing;
  expiresAt: number;
}

/**
 * How long one tenant's listing is trusted. The campaign editor is opened in
 * bursts — several rules in one sitting — and five minutes turns that sitting
 * into one Graph call, while a campaign launched mid-meeting still shows up
 * before the meeting ends.
 */
const SUCCESS_TTL_MS = 5 * 60 * 1000;

/**
 * A failed listing is remembered much more briefly: long enough that a dialog
 * reopened three times does not retry a dead token three times, short enough
 * that fixing the connection brings the picker back without a redeploy.
 */
const FAILURE_TTL_MS = 60 * 1000;

/**
 * One page only, deliberately. The picker exists so head office can choose a
 * RUNNING campaign; an account with more than a hundred simultaneously active
 * campaigns is not choosing from a dropdown anyway, and the manual name/link
 * entry underneath it still covers everything.
 */
const PAGE_LIMIT = '100';

/**
 * Ads per campaign. Lower than the campaign page because the creative's
 * call-to-action is fetched with them, and a jeweller runs a handful of
 * creatives per campaign, not fifty.
 */
const AD_LIMIT = '50';

/**
 * Only ads that actually land the customer in WhatsApp can start a scripted
 * conversation -- a website or lead-form ad never produces a referral, so a
 * script attached to it could never fire. On this account 45 of the 50 running
 * campaigns are of that second kind, and listing them would bury the five that
 * work. Meta spells the destination in the creative's call to action.
 */
function toWhatsApp(callToAction: string | null): boolean {
  return Boolean(callToAction && callToAction.toUpperCase().includes('WHATSAPP'));
}

/**
 * The account's running campaigns and ads, fetched live from Meta so the
 * campaign editor offers a pick-list instead of asking head office to retype a
 * name or paste a link (client, 13 Oct).
 *
 * Failure is not an error: no connection, no registered ad account or a Graph
 * refusal all answer `available: false` with a reason, and the editor falls
 * back to the typed name / pasted link it always had. A 500 here would block
 * the manual path that still works.
 */
@Injectable()
export class MetaAdsListService {
  private readonly logger = new Logger(MetaAdsListService.name);

  /**
   * Process-local, one entry per organisation — bounded by the tenant count,
   * so no eviction policy is needed. Same reasoning as MetaAdMetadataService:
   * a restart costs one Graph call per tenant, and the TTL handles renames.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
  ) {}

  async list(organisationId: string): Promise<MetaAdsListing> {
    const hit = this.cache.get(organisationId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await this.fetch(organisationId);
    this.cache.set(organisationId, {
      value,
      expiresAt: Date.now() + (value.available ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
    });
    return value;
  }

  private async fetch(organisationId: string): Promise<MetaAdsListing> {
    const integration = await this.prisma.integration.findFirst({
      where: {
        organisationId,
        providerCode: META_ADS_PROVIDER_CODE,
        status: { not: 'disabled' },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!integration) {
      return unavailable('Meta Ads is not connected for this organisation.');
    }

    const account = await this.prisma.integrationAsset.findFirst({
      where: {
        organisationId,
        integrationId: integration.id,
        kind: 'ad_account',
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { externalId: true },
    });
    if (!account) {
      return unavailable('No Meta ad account is registered on the connection.');
    }
    const accountId = account.externalId.trim().replace(/^act_/i, '');
    if (!/^[1-9]\d{4,31}$/.test(accountId)) {
      return unavailable('The registered Meta ad account id is not usable.');
    }

    try {
      const response = await this.graph.getForIntegration<GraphCampaignsResponse>(
        organisationId,
        integration.id,
        `act_${accountId}/campaigns`,
        {
          fields:
            `id,name,status,ads.limit(${AD_LIMIT})` +
            '{id,name,status,creative{call_to_action_type}}',
          // Running campaigns only — the whole point of the picker. Paused and
          // archived ones would outnumber the live ones within a season.
          effective_status: '["ACTIVE"]',
          limit: PAGE_LIMIT,
        },
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      const campaigns: MetaCampaignChoice[] = [];
      for (const row of rows) {
        const id = text(row?.id);
        const name = text(row?.name);
        const status = text(row?.status);
        // `effective_status` above filters server-side; the re-check here keeps
        // a campaign Meta returned anyway from being offered as "running".
        if (!id || !name || status !== 'ACTIVE') continue;
        const ads: MetaAdChoice[] = [];
        for (const ad of Array.isArray(row?.ads?.data) ? row.ads.data : []) {
          const adId = text(ad?.id);
          const adName = text(ad?.name);
          const adStatus = text(ad?.status);
          if (!adId || !adName || adStatus !== 'ACTIVE') continue;
          if (!toWhatsApp(text(ad?.creative?.call_to_action_type))) continue;
          ads.push({ id: adId, name: adName, status: adStatus });
        }
        // A campaign with no WhatsApp ad cannot start a conversation, so it is
        // not offered -- picking it would create a rule that never matches.
        if (!ads.length) continue;
        campaigns.push({ id, name, status, ads });
      }
      if (!campaigns.length) {
        return unavailable(
          'No running campaign sends people to WhatsApp, so there is nothing to attach a conversation to yet.',
        );
      }
      return { available: true, reason: null, campaigns };
    } catch (error) {
      // MetaGraphError messages are already redacted and bounded; anything else
      // stays in the log, and the client gets one plain sentence.
      this.logger.warn(
        `Could not list Meta campaigns: ${error instanceof Error ? error.message : String(error)}`,
      );
      return unavailable('Meta did not answer. Type the campaign name or paste the ad link instead.');
    }
  }

  /** Drop everything. For tests, and for a launch that must show up now. */
  clearCache() {
    this.cache.clear();
  }
}

function unavailable(reason: string): MetaAdsListing {
  return { available: false, reason, campaigns: [] };
}

interface GraphCampaignsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    status?: string;
    ads?: {
      data?: Array<{
        id?: string;
        name?: string;
        status?: string;
        creative?: { call_to_action_type?: string };
      }>;
    };
  }>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
}
