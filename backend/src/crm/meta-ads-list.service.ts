import { Injectable, Logger } from '@nestjs/common';

import { META_ADS_PROVIDER_CODE } from '../integrations/meta-asset-ownership.service';
import { MetaGraphClient, MetaGraphError } from '../integrations/meta-graph.client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How a customer reaches WhatsApp from this ad, which decides who speaks first.
 *
 * `whatsapp`  Click-to-WhatsApp. The customer opens the chat and writes, Meta
 *             sends a referral, the 24-hour window opens, and the script
 *             replies. Free-form.
 *
 * `lead_form` A Meta instant form. The customer fills it in and Meta hands
 *             them into WhatsApp with their answers pre-filled; they send
 *             that as the first message. So this behaves exactly like the
 *             above -- referral, open window, no template -- and the only
 *             real difference is that the opening message already contains
 *             the name, budget, timeline and preferred branch. Confirmed on a
 *             live conversation (ad 120256672661940226, "16/11 - bridal lead
 *             - Broadway"), which arrived with evidence `measured` and a
 *             click id, and met the DEFAULT script because no rule could be
 *             attached to a lead ad yet -- so it asked for what the customer
 *             had just typed.
 */
export type MetaAdKind = 'whatsapp' | 'lead_form';

export interface MetaAdChoice {
  id: string;
  name: string;
  status: string;
  /** How this ad gets the customer into WhatsApp — see MetaAdKind. */
  kind: MetaAdKind;
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
  /**
   * The kinds its listed ads are. Usually one, but a campaign may legitimately
   * run both, and the editor labels it from this rather than guessing.
   */
  kinds: MetaAdKind[];
}

export interface MetaAdsListing {
  available: boolean;
  /** Why the picker cannot be offered. Null whenever `available` is true. */
  reason: string | null;
  campaigns: MetaCampaignChoice[];
  /**
   * Running campaigns deliberately left out because their ads do not open
   * WhatsApp.
   *
   * Counted and reported because the silence was read as staleness. The
   * account runs hundreds of catalogue and lead-form campaigns; the picker
   * showed the eight that can carry a WhatsApp conversation and said nothing
   * about the rest, so a new lead-form campaign appearing nowhere looked
   * exactly like "the CRM is not pulling new ads". It was pulling them and
   * discarding them, correctly, without saying so.
   */
  otherRunning?: number;
  /** When this was actually read from Meta, so the age is visible. */
  readAt?: string;
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
 * Which ads can carry a scripted conversation, and how.
 *
 * Originally this listed Click-to-WhatsApp only, on the reasoning that a lead
 * form never produces a referral so a script attached to one could never fire.
 * True of the referral, wrong about the lead: a form lead reaches WhatsApp a
 * moment later -- by tapping "Chat on WhatsApp" on the form's end screen, or
 * by answering a template -- and from their reply onwards it is an ordinary
 * conversation that a script can run. The client asked for lead forms by name
 * (17 Nov); their lead campaigns are already one per branch.
 *
 * Read from the ad set's destination, with the creative's call to action as a
 * fallback. Both are needed, and neither alone is enough: on this account 245
 * active ads report destination UNDEFINED, some of which carry the CTA
 * WHATSAPP_MESSAGE and genuinely do open a chat; while the lead forms declare
 * ON_AD or WEBSITE_AND_LEAD_FORM and carry CTAs (GET_OFFER, SEE_DETAILS) that
 * say nothing about any destination.
 *
 * A website, catalogue, Instagram-profile or post ad is still left out. Those
 * never reach WhatsApp at all, so there is no conversation to script.
 */
const WHATSAPP_DESTINATIONS = new Set(['WHATSAPP']);
const LEAD_FORM_DESTINATIONS = new Set(['ON_AD', 'WEBSITE_AND_LEAD_FORM']);

export function adKind(destination: string | null, callToAction: string | null): MetaAdKind | null {
  const dest = destination?.toUpperCase() ?? '';
  const cta = callToAction?.toUpperCase() ?? '';
  if (WHATSAPP_DESTINATIONS.has(dest) || cta.includes('WHATSAPP')) return 'whatsapp';
  if (LEAD_FORM_DESTINATIONS.has(dest)) return 'lead_form';
  return null;
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

  /**
   * `refresh` skips the cache.
   *
   * The five-minute cache is right for a picker somebody opens repeatedly, and
   * wrong the moment a marketer launches a campaign and wants to script it
   * now. Waiting out a cache they cannot see reads as "the CRM is not pulling
   * my ads" — so there is a button, and it does exactly what it says.
   */
  async list(organisationId: string, refresh = false): Promise<MetaAdsListing> {
    const hit = this.cache.get(organisationId);
    if (!refresh && hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await this.fetch(organisationId);
    const readAt = new Date().toISOString();
    const stamped: MetaAdsListing = { ...value, readAt };
    this.cache.set(organisationId, {
      value: stamped,
      expiresAt: Date.now() + (value.available ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
    });
    return stamped;
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
      /*
       * Campaigns running right now whose ads go somewhere other than
       * WhatsApp. Counted so the picker can SAY it dropped them: this account
       * runs hundreds of catalogue and lead-form campaigns, and silently
       * showing only the handful that open a chat is indistinguishable from
       * stale data when the ones you just launched are among the hundreds.
       */
      const nonWhatsApp = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response: GraphAdsResponse = await this.graph.getForIntegration<GraphAdsResponse>(
          organisationId,
          integration.id,
          `act_${accountId}/ads`,
          {
            fields:
              'id,name,status,campaign{id,name,status},adset{destination_type},' +
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
          // An ad that never reaches WhatsApp at all has no conversation to
          // script. A lead form does reach it, a moment later — see adKind.
          const kind = adKind(
            text(ad?.adset?.destination_type),
            text(ad?.creative?.call_to_action_type),
          );
          if (!kind) {
            const otherId = text(ad?.campaign?.id);
            if (otherId) nonWhatsApp.add(otherId);
            continue;
          }
          const campaignId = text(ad?.campaign?.id);
          const campaignName = text(ad?.campaign?.name);
          if (!campaignId || !campaignName) continue;
          const campaignStatus = text(ad?.campaign?.status) ?? 'ACTIVE';
          const existing = byCampaign.get(campaignId) ?? {
            id: campaignId,
            name: campaignName,
            status: campaignStatus,
            ads: [],
            kinds: [],
          };
          existing.ads.push({
            id: adId,
            name: adName,
            status: adStatus,
            kind,
            aliasIds: aliasesFor(ad?.creative),
          });
          if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
          byCampaign.set(campaignId, existing);
        }
        after = text(response?.paging?.cursors?.after);
        if (!response?.paging?.next || !after) break;
      }
      const campaigns = [...byCampaign.values()];
      if (!campaigns.length) {
        /*
         * "Nothing is running" and "plenty is running, none of it opens a
         * chat" are different situations and need different sentences. The
         * second is the one this account is actually in, and answering it with
         * the first is what sent somebody looking for a sync bug.
         */
        return {
          ...unavailable(
              nonWhatsApp.size
                ? `None of your ${nonWhatsApp.size} running campaigns can reach WhatsApp. A bot ` +
                  'conversation needs either a click-to-WhatsApp ad or a lead form — a catalogue, ' +
                  'website or profile ad never gets the customer into a chat, so there is nothing ' +
                  'for the bot to reply in.'
                : 'No running campaign reaches WhatsApp, so there is nothing to attach a conversation to yet.',
          ),
          otherRunning: nonWhatsApp.size,
        };
      }
      return { available: true, reason: null, campaigns, otherRunning: nonWhatsApp.size };
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
    /** Where the ad sends the customer: WHATSAPP, ON_AD (instant form), … */
    adset?: { destination_type?: string };
    creative?: GraphCreative;
  }>;
  paging?: { next?: string; cursors?: { after?: string } };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
}
