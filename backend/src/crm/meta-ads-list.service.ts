import { Injectable, Logger } from '@nestjs/common';

import { META_ADS_PROVIDER_CODE } from '../integrations/meta-asset-ownership.service';
import { MetaGraphClient, MetaGraphError } from '../integrations/meta-graph.client';
import { PrismaService } from '../prisma/prisma.service';

export interface MetaAdChoice {
  id: string;
  name: string;
  status: string;
  /**
   * The other ids this same ad can arrive as on a Click-to-WhatsApp referral:
   * its page-post id and its Instagram media id. Meta does not always send the
   * ad id Ads Manager shows, so a rule pinned to one id alone can silently
   * never match. Saved with the rule and matched alongside it.
   */
  aliasIds: string[];
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
 * How many pages of ads to walk. 100 ads a page covers this account's running
 * ads several times over; the bound is what stops a runaway account turning
 * one dialog into a hundred Graph calls.
 */
const MAX_PAGES = 5;

/**
 * Ads per campaign. Lower than the campaign page because the creative's
 * call-to-action is fetched with them, and a jeweller runs a handful of
 * creatives per campaign, not fifty.
 */

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
    /*
     * A tenant can hold more than one Meta connection -- an abandoned first
     * attempt beside the one somebody actually finished. Taking the OLDEST
     * read the abandoned one and reported "Meta did not answer" while the
     * live connection sat there working, so the pick is now made on evidence:
     * newest first, and only a connection that has BOTH a stored credential
     * and a registered ad account can serve the picker.
     */
    const candidates = await this.prisma.integration.findMany({
      where: {
        organisationId,
        providerCode: META_ADS_PROVIDER_CODE,
        status: { not: 'disabled' },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!candidates.length) {
      return unavailable('Meta Ads is not connected for this organisation.');
    }

    let integration: { id: string } | null = null;
    let account: { externalId: string } | null = null;
    let sawAccountWithoutCredential = false;
    for (const candidate of candidates) {
      const [asset, credential] = await Promise.all([
        this.prisma.integrationAsset.findFirst({
          where: {
            organisationId,
            integrationId: candidate.id,
            kind: 'ad_account',
            isActive: true,
          },
          orderBy: { createdAt: 'desc' },
          select: { externalId: true },
        }),
        // Presence only; the ciphertext is never selected.
        this.prisma.integrationCredential.findFirst({
          where: { organisationId, integrationId: candidate.id, kind: 'access_token' },
          select: { id: true },
        }),
      ]);
      if (!asset) continue;
      if (!credential) {
        sawAccountWithoutCredential = true;
        continue;
      }
      integration = candidate;
      account = asset;
      break;
    }
    if (!integration || !account) {
      return unavailable(
        sawAccountWithoutCredential
          ? 'The Meta connection holding the ad account has no access token saved.'
          : 'No Meta ad account is registered on the connection.',
      );
    }
    const accountId = account.externalId.trim().replace(/^act_/i, '');
    if (!/^[1-9]\d{4,31}$/.test(accountId)) {
      return unavailable('The registered Meta ad account id is not usable.');
    }

    try {
      /*
       * Read the ADS edge, not campaigns-with-nested-ads.
       *
       * Asking for every campaign with its ads and their creatives in one go
       * produced 79,916 bytes on this account, and the Graph client parses at
       * most 64,000 -- so the JSON arrived cut in half and the picker reported
       * "Meta Graph returned an unreadable response" for a connection that was
       * working perfectly. The same information off the ads edge is ~40KB at
       * the same page size, carries its campaign with it, and pages cleanly.
       */
      const byCampaign = new Map<string, MetaCampaignChoice>();
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response: GraphAdsResponse = await this.graph.getForIntegration<GraphAdsResponse>(
          organisationId,
          integration.id,
          `act_${accountId}/ads`,
          {
            fields:
              'id,name,status,campaign{id,name,status},' +
              'creative{call_to_action_type,effective_object_story_id,effective_instagram_media_id}',
            // Running ads only — the whole point of the picker.
            effective_status: '["ACTIVE"]',
            limit: PAGE_LIMIT,
            ...(after ? { after } : {}),
          },
        );
        const rows = Array.isArray(response?.data) ? response.data : [];
        for (const ad of rows) {
          const adId = text(ad?.id);
          const adName = text(ad?.name);
          const adStatus = text(ad?.status);
          if (!adId || !adName || adStatus !== 'ACTIVE') continue;
          // An ad that does not open WhatsApp can never produce a referral, so
          // a conversation attached to it could never fire.
          if (!toWhatsApp(text(ad?.creative?.call_to_action_type))) continue;
          const campaignId = text(ad?.campaign?.id);
          const campaignName = text(ad?.campaign?.name);
          if (!campaignId || !campaignName) continue;
          const campaignStatus = text(ad?.campaign?.status) ?? 'ACTIVE';
          const existing = byCampaign.get(campaignId) ?? {
            id: campaignId,
            name: campaignName,
            status: campaignStatus,
            ads: [],
          };
          existing.ads.push({
            id: adId,
            name: adName,
            status: adStatus,
            aliasIds: aliasesFor(ad?.creative),
          });
          byCampaign.set(campaignId, existing);
        }
        after = text(response?.paging?.cursors?.after);
        if (!response?.paging?.next || !after) break;
      }
      const campaigns = [...byCampaign.values()];
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
      /*
       * The provider's own sentence, not a guess. MetaGraphError messages are
       * already redacted and length-bounded, and one generic line here is what
       * made an unsaved token look like a Meta outage.
       */
      const detail = error instanceof MetaGraphError ? error.message : null;
      return unavailable(
        detail
          ? `Meta could not be read: ${detail}`
          : 'Meta did not answer. Type the campaign name or paste the ad link instead.',
      );
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

/**
 * Every other id the referral might carry for this ad. A page-post id arrives
 * both whole (`<page>_<post>`) and as the post half alone, so both are kept.
 */
function aliasesFor(creative: GraphCreative | undefined): string[] {
  const out: string[] = [];
  const story = text(creative?.effective_object_story_id);
  if (story) {
    out.push(story);
    const post = story.includes('_') ? story.slice(story.indexOf('_') + 1) : '';
    if (post) out.push(post);
  }
  const insta = text(creative?.effective_instagram_media_id);
  if (insta) out.push(insta);
  return out.filter((id, i) => id && out.indexOf(id) === i).slice(0, 8);
}

interface GraphCreative {
  call_to_action_type?: string;
  effective_object_story_id?: string;
  effective_instagram_media_id?: string;
}

interface GraphAdsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    status?: string;
    campaign?: { id?: string; name?: string; status?: string };
    creative?: GraphCreative;
  }>;
  paging?: { next?: string; cursors?: { after?: string } };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
}
