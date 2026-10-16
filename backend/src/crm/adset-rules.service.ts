import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { canOpenById } from '../auth/access';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { updateOrgSettings } from '../config/org-settings';

/**
 * What a rule matches on.
 *
 * Meta puts the AD id in a Click-to-WhatsApp referral and nothing else, so
 * `ad_id` was for a long time the only field a click could satisfy.
 *
 * That made routing unusable at any real advertising volume: a showroom runs a
 * new ad for every collection, and every one of them would need its id pasted
 * into a rule by hand before its leads reached a branch. Miss one and those
 * customers land in the head-office queue.
 *
 * `MetaAdMetadataService` now resolves the ad id to its ad set and campaign, so
 * **`ad_set_name` and `campaign_name` are the fields to configure**: one rule per
 * SHOWROOM, matched on the name the marketing team already uses. Every future ad
 * inside that ad set routes with no further configuration.
 *
 * `ad_id` and `ad_set_id` remain for pinning a single ad somewhere different
 * from its name — an exception, not the pattern.
 */
export type AdSetMatchField =
  | 'ad_id'
  | 'ad_set_id'
  | 'ad_set_name'
  | 'campaign_name'
  | 'tag';

/**
 * Prompt size limits, shared by the write guard and the defensive read slice.
 * The editor counts against these same two numbers, so the screen and the
 * server can never disagree about what will fit.
 */
export const AI_CONTEXT_MAX = 5000;
export const AI_GUARDRAILS_MAX = 2000;
/** The campaign's configured conversation (client, 8 Oct): same shared limits. */
export const FIRST_REPLY_MAX = 1200;
export const CAMPAIGN_QUESTION_MAX = 300;
export const CAMPAIGN_QUESTIONS_MAX = 5;
export const CAMPAIGN_OPTION_MAX = 60;
export const CAMPAIGN_OPTIONS_MAX = 6;
export const AD_LINK_MAX = 500;

/** Refuse, rather than trim, a campaign conversation that is over its limits. */
export function assertCampaignLengths(
  name: string,
  value: { firstReply?: unknown; questions?: unknown; adLink?: unknown } | null | undefined,
): void {
  const where = name ? ` for "${name}"` : '';
  if (typeof value?.firstReply === 'string' && value.firstReply.trim().length > FIRST_REPLY_MAX) {
    throw new BadRequestException(`The first reply${where} is over ${FIRST_REPLY_MAX} characters.`);
  }
  if (typeof value?.adLink === 'string' && value.adLink.trim().length > AD_LINK_MAX) {
    throw new BadRequestException(`The ad link${where} is over ${AD_LINK_MAX} characters.`);
  }
  if (!Array.isArray(value?.questions)) return;
  if (value.questions.length > CAMPAIGN_QUESTIONS_MAX) {
    throw new BadRequestException(`A conversation${where} takes at most ${CAMPAIGN_QUESTIONS_MAX} questions.`);
  }
  for (const q of value.questions as unknown[]) {
    const text = typeof q === 'string' ? q : (q as { text?: unknown })?.text;
    if (typeof text === 'string' && text.trim().length > CAMPAIGN_QUESTION_MAX) {
      throw new BadRequestException(`A question${where} is over ${CAMPAIGN_QUESTION_MAX} characters.`);
    }
    const options = (q as { options?: unknown })?.options;
    if (!Array.isArray(options)) continue;
    if (options.length > CAMPAIGN_OPTIONS_MAX) {
      throw new BadRequestException(`A question${where} takes at most ${CAMPAIGN_OPTIONS_MAX} choices.`);
    }
    if (options.some((o) => typeof o === 'string' && o.trim().length > CAMPAIGN_OPTION_MAX)) {
      throw new BadRequestException(`A choice${where} is over ${CAMPAIGN_OPTION_MAX} characters.`);
    }
  }
}

/**
 * One question the campaign's owner wants asked. `options` are HINTS the
 * assistant may weave into a sentence ("rings, chains, or something else?") —
 * they are NEVER sent as interactive buttons or numbered menus; the customer
 * answers in their own words either way (client, 12 Oct).
 */
export interface CampaignQuestion {
  text: string;
  options?: string[];
}

/**
 * Questions as stored: new entries are objects, rows written before 12 Oct
 * are plain strings. Both read; everything is re-written as objects.
 */
export function normaliseCampaignQuestions(value: unknown): CampaignQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((q): CampaignQuestion | null => {
      if (typeof q === 'string') {
        const text = q.trim().slice(0, CAMPAIGN_QUESTION_MAX);
        return text ? { text } : null;
      }
      if (q && typeof q === 'object' && typeof (q as { text?: unknown }).text === 'string') {
        const raw = q as { text: string; options?: unknown };
        const text = raw.text.trim().slice(0, CAMPAIGN_QUESTION_MAX);
        if (!text) return null;
        const options = Array.isArray(raw.options)
          ? raw.options
              .filter((o): o is string => typeof o === 'string' && Boolean(o.trim()))
              .map((o) => o.trim().slice(0, CAMPAIGN_OPTION_MAX))
              .slice(0, CAMPAIGN_OPTIONS_MAX)
          : [];
        return options.length ? { text, options } : { text };
      }
      return null;
    })
    .filter((q): q is CampaignQuestion => q !== null)
    .slice(0, CAMPAIGN_QUESTIONS_MAX);
}

export type AdSetHandling = 'ai' | 'human';

export interface AdSetAutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchField: AdSetMatchField;
  matchValue: string;
  storeId: string | null;
  assignedUserId: string | null;
  handling: AdSetHandling;
  aiContext?: string | null;
  aiGuardrails?: string | null;
  /**
   * The campaign's conversation, as the client configures it (8 Oct): the ad
   * link pasted from Meta (kept, and PARSED — see `adIdFromLink`), the exact
   * first message a customer arriving from this campaign receives, and the
   * questions the assistant should work toward. All optional: a rule without
   * them keeps today's behaviour.
   */
  adLink?: string | null;
  /**
   * The OTHER ids this same advertisement can arrive as. One ad has an ad id,
   * a page-post id and an Instagram media id, and a Click-to-WhatsApp referral
   * does not always carry the one Ads Manager shows -- which is why this
   * tenant once held four hand-made rules for a single demo ad, each guessing
   * a different id. Pinning an ad from the picker records all of them, so the
   * rule matches whichever form Meta sends.
   */
  adAliases?: string[];
  firstReply?: string | null;
  questions?: CampaignQuestion[];
  /**
   * Whether the assistant converses after the opener (client, 12 Oct: "ask do
   * we want AI replies"). Off, the first reply still sends exactly as written
   * and the very next customer message goes to a person. Absent means on, so
   * every campaign saved before the toggle existed keeps its behaviour.
   */
  aiReplies?: boolean;
}

export interface AdSetRoutingContext {
  /** Provider ad id — the only identifier a CTWA referral supplies. */
  adId?: string;
  /** The rest are RESOLVED from the ad id, never sent by Meta on a click. */
  adSetId?: string;
  adSetName?: string;
  campaignId?: string;
  campaignName?: string;
  tags?: string[];
}

export interface AdSetRoutingDecision {
  ruleId: string;
  ruleName: string;
  storeId: string | null;
  assignedUserId: string | null;
  handling: AdSetHandling;
  aiContext?: string | null;
  aiGuardrails?: string | null;
  firstReply?: string | null;
  questions?: CampaignQuestion[];
}

/**
 * The ad id buried in a pasted Meta link, or null.
 *
 * "Pasting a campaign link must connect to routing" (client, 8 Oct) — so a
 * link is parsed, not filed. Meta puts the ad id in several shapes of URL
 * (ads manager `selected_ad_ids=`, ads library `?id=`, permalinks); all of
 * them carry it as the longest pure-digit run, and real ad ids are long.
 * Anything under 10 digits is a year or a pixel size, never an ad id.
 */
export function adIdFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const named = /(?:selected_ad_ids|ad_id|adid|id)=(\d{10,})/i.exec(link);
  if (named) return named[1];
  const runs = link.match(/\d{10,}/g);
  if (!runs?.length) return null;
  return runs.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Tenant-owned rules for routing an ad response before it reaches the inbox. */
@Injectable()
export class AdSetRulesService {
  private readonly logger = new Logger(AdSetRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(organisationId: string): Promise<AdSetAutomationRule[]> {
    const organisation = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (organisation?.settings ?? {}) as Record<string, unknown>;
    return normaliseRules(settings.crmAdSetRules);
  }

  async replace(user: AuthUser, input: AdSetAutomationRule[]) {
    /*
     * Length is REFUSED here, not trimmed.
     *
     * `normaliseRules` slices an over-long prompt because it also runs on read,
     * where a stored value has to be made safe rather than rejected. On a write
     * that same slice is a silent edit: somebody pastes a brief, is told it
     * saved, and the assistant is then briefed with a sentence that stops
     * mid-word. The limits match the character counters in the editor, so a
     * refusal here can only mean the client's own guard was bypassed.
     */
    for (const rule of input ?? []) {
      const name = typeof rule?.name === 'string' ? rule.name : '';
      if (typeof rule?.aiContext === 'string' && rule.aiContext.length > AI_CONTEXT_MAX) {
        throw new BadRequestException(
          `The AI context for "${name}" is ${rule.aiContext.length} characters; the limit is ${AI_CONTEXT_MAX}.`,
        );
      }
      if (typeof rule?.aiGuardrails === 'string' && rule.aiGuardrails.length > AI_GUARDRAILS_MAX) {
        throw new BadRequestException(
          `The guardrails for "${name}" are ${rule.aiGuardrails.length} characters; the limit is ${AI_GUARDRAILS_MAX}.`,
        );
      }
      // The first reply is sent to customers word for word, so a cut one would
      // go out ending mid-sentence. The same for questions, choices and links.
      assertCampaignLengths(name, rule);
    }

    const rules = normaliseRules(input);
    if (rules.length !== input.length) {
      throw new BadRequestException('Every ad-set rule must have a unique id, name and match value.');
    }

    const storeIds = [...new Set(rules.map((rule) => rule.storeId).filter(Boolean))] as string[];
    if (storeIds.length) {
      const found = await this.prisma.store.count({
        where: {
          organisationId: user.organisationId,
          id: { in: storeIds },
          isAggregate: false,
          isHolding: false,
          attendanceOnly: false,
          status: { not: 'closed' },
        },
      });
      if (found !== storeIds.length) throw new BadRequestException('A destination store is not part of this organisation.');
    }

    const userIds = [...new Set(rules.map((rule) => rule.assignedUserId).filter(Boolean))] as string[];
    if (userIds.length) {
      const found = await this.prisma.user.count({
        where: { organisationId: user.organisationId, id: { in: userIds }, isActive: true },
      });
      if (found !== userIds.length) throw new BadRequestException('An assignee is not an active user in this organisation.');
    }

    const storeAssignments = rules.filter((rule) => rule.storeId && rule.assignedUserId);
    if (storeAssignments.length) {
      const memberships = await this.prisma.userStore.findMany({
        where: {
          OR: storeAssignments.map((rule) => ({ userId: rule.assignedUserId!, storeId: rule.storeId! })),
        },
        select: { userId: true, storeId: true },
      });
      const membershipKeys = new Set(memberships.map((row) => `${row.userId}:${row.storeId}`));
      if (storeAssignments.some((rule) => !membershipKeys.has(`${rule.assignedUserId}:${rule.storeId}`))) {
        throw new BadRequestException('An assignee must belong to the destination store.');
      }
    }

    // The widest window of the three: three validation round-trips used to sit
    // between reading this bag and writing it back. Under the lock the elapsed
    // time no longer matters.
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => ({
      ...settings,
      crmAdSetRules: rules as unknown as Record<string, unknown>,
    }));
    await this.audit.record(user, {
      action: 'crm.adset_rules_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Updated ${rules.length} ad-set automation rule(s)`,
      metadata: { ruleIds: rules.map((rule) => rule.id) },
    });
    return rules;
  }

  /**
   * `screen` is where the routed work lives: Conversations for a message, CRM
   * for a lead. A rule keeps its store when the person it names cannot open
   * that screen; only the person is dropped, so the work is never left with
   * somebody who cannot see it.
   */
  async resolve(
    organisationId: string,
    context: AdSetRoutingContext | undefined,
    screen: 'crm' | 'conversations',
  ): Promise<AdSetRoutingDecision | null> {
    if (!context) return null;
    const rule = resolveAdSetRule(await this.list(organisationId), context);
    if (rule?.storeId) {
      const physicalStore = await this.prisma.store.findFirst({
        where: {
          id: rule.storeId,
          organisationId,
          isAggregate: false,
          isHolding: false,
          attendanceOnly: false,
          status: { not: 'closed' },
        },
        select: { id: true },
      });
      // Old settings may predate the holding-store boundary. Treat that stale
      // destination as no matching route rather than filing new CRM records in
      // an import quarantine bucket.
      if (!physicalStore) {
        this.logger.warn(
          `Ad-set rule ${rule.id} points at store ${rule.storeId}, which is closed or not a physical ` +
            'branch; treating the lead as unrouted.',
        );
        return null;
      }
    }
    return rule
      ? {
          ruleId: rule.id,
          ruleName: rule.name,
          storeId: rule.storeId,
          assignedUserId:
            rule.assignedUserId && (await canOpenById(this.prisma, organisationId, rule.assignedUserId, screen))
              ? rule.assignedUserId
              : null,
          handling: rule.handling,
          aiContext: rule.aiContext ?? null,
          aiGuardrails: rule.aiGuardrails ?? null,
          firstReply: rule.firstReply ?? null,
          ...(rule.questions?.length ? { questions: rule.questions } : {}),
        }
      : null;
  }
}

/**
 * An exact identifier match. Ranked above every name match, and above any
 * priority number, because an id names one ad and cannot mean two showrooms.
 */
const EXACT_MATCH = Number.MAX_SAFE_INTEGER;

/**
 * Which rule wins when several match.
 *
 * Specificity first, `priority` second — and specificity is DERIVED from the
 * match rather than typed by anyone.
 *
 * ## Why longest match, not priority
 *
 * Éclat runs showrooms at Bandra and at Bandra Broadway. A rule matching
 * "bandra" also matches the ad set named "Lead Campaign - bandra broadway",
 * so with priority alone the correct routing depends on somebody remembering
 * to rank Broadway above Bandra. That is the class of configuration which is
 * right on the day it is written and silently wrong a year later, when a
 * colleague adds a showroom and the leads for it quietly go to the wrong
 * branch — with no error anywhere.
 *
 * Scoring a name match by the LENGTH of the text it matched makes
 * "bandra broadway" beat "bandra" structurally. The more specific rule wins
 * because it is more specific, not because of a number.
 *
 * `priority` still decides genuine ties, so a tenant keeps a manual override
 * for two rules of equal specificity.
 */
export function resolveAdSetRule(rules: AdSetAutomationRule[], context: AdSetRoutingContext) {
  const tags = (context.tags ?? []).map(normalise);
  const matched: { rule: AdSetAutomationRule; specificity: number }[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const expected = normalise(rule.matchValue);
    // An empty match value would `includes()` into everything and route all
    // traffic to one branch.
    if (!expected) continue;

    switch (rule.matchField) {
      case 'ad_id': {
        const incoming = normalise(context.adId);
        const aliases = (rule.adAliases ?? []).map(normalise).filter(Boolean);
        if (incoming && (incoming === expected || aliases.includes(incoming))) {
          matched.push({ rule, specificity: EXACT_MATCH });
        }
        break;
      }
      case 'ad_set_id':
        if (normalise(context.adSetId) === expected) matched.push({ rule, specificity: EXACT_MATCH });
        break;
      case 'tag':
        if (tags.includes(expected)) matched.push({ rule, specificity: EXACT_MATCH });
        break;
      case 'ad_set_name':
        if (normalise(context.adSetName).includes(expected)) {
          matched.push({ rule, specificity: expected.length });
        }
        break;
      case 'campaign_name':
        if (normalise(context.campaignName).includes(expected)) {
          matched.push({ rule, specificity: expected.length });
        }
        break;
    }
  }

  matched.sort((a, b) => b.specificity - a.specificity || b.rule.priority - a.rule.priority);
  return matched[0]?.rule ?? null;
}

function normaliseRules(value: unknown): AdSetAutomationRule[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    const rule = candidate as Partial<AdSetAutomationRule>;
    const id = typeof rule.id === 'string' ? rule.id.trim() : '';
    const name = typeof rule.name === 'string' ? rule.name.trim() : '';
    const adLink =
      typeof rule.adLink === 'string' && rule.adLink.trim()
        ? rule.adLink.trim().slice(0, AD_LINK_MAX)
        : null;
    // A pasted ad link IS a match: when no match value was typed, the ad id
    // parsed out of the link becomes an exact ad_id rule. The link never sits
    // as a dead text field (client, 8 Oct).
    let matchField = rule.matchField;
    let matchValue = typeof rule.matchValue === 'string' ? rule.matchValue.trim() : '';
    if (!matchValue && adLink) {
      const parsed = adIdFromLink(adLink);
      if (parsed) {
        matchField = 'ad_id';
        matchValue = parsed;
      }
    }
    if (!id || !name || !matchValue || seen.has(id)) return [];
    if (
      !['ad_id', 'ad_set_id', 'ad_set_name', 'campaign_name', 'tag'].includes(matchField ?? '')
    ) {
      return [];
    }
    if (!['ai', 'human'].includes(rule.handling ?? '')) return [];
    seen.add(id);
    const questions = normaliseCampaignQuestions(rule.questions);
    return [{
      id,
      name,
      enabled: rule.enabled !== false,
      priority: Number.isInteger(rule.priority) ? Math.max(0, Math.min(1000, rule.priority!)) : 100,
      matchField: matchField!,
      matchValue,
      storeId: typeof rule.storeId === 'string' && rule.storeId ? rule.storeId : null,
      assignedUserId: typeof rule.assignedUserId === 'string' && rule.assignedUserId ? rule.assignedUserId : null,
      handling: rule.handling!,
      aiContext: typeof rule.aiContext === 'string' && rule.aiContext.trim() ? rule.aiContext.trim().slice(0, AI_CONTEXT_MAX) : null,
      aiGuardrails: typeof rule.aiGuardrails === 'string' && rule.aiGuardrails.trim() ? rule.aiGuardrails.trim().slice(0, AI_GUARDRAILS_MAX) : null,
      adLink,
      firstReply:
        typeof rule.firstReply === 'string' && rule.firstReply.trim()
          ? rule.firstReply.trim().slice(0, FIRST_REPLY_MAX)
          : null,
      ...(questions.length ? { questions } : {}),
      ...(Array.isArray(rule.adAliases)
        ? {
            adAliases: rule.adAliases
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.trim())
              // Meta ids are digits; a page-post id is two joined by "_".
              .filter((id) => /^[0-9]{5,32}(_[0-9]{5,32})?$/.test(id))
              .slice(0, 8),
          }
        : {}),
      // Off unless switched on: absence is never consent to let a model answer
      // customers unread.
      aiReplies: rule.aiReplies === true,
    }];
  });
}

function normalise(value?: string) {
  return (value ?? '').trim().toLocaleLowerCase('en-IN');
}
