import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
}

/** Tenant-owned rules for routing an ad response before it reaches the inbox. */
@Injectable()
export class AdSetRulesService {
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
    }

    const rules = normaliseRules(input);
    if (rules.length !== input.length) {
      throw new BadRequestException('Every ad-set rule must have a unique id, name and match value.');
    }

    const storeIds = [...new Set(rules.map((rule) => rule.storeId).filter(Boolean))] as string[];
    if (storeIds.length) {
      const found = await this.prisma.store.count({
        where: { organisationId: user.organisationId, id: { in: storeIds }, isAggregate: false },
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

  async resolve(organisationId: string, context?: AdSetRoutingContext): Promise<AdSetRoutingDecision | null> {
    if (!context) return null;
    const rule = resolveAdSetRule(await this.list(organisationId), context);
    return rule
      ? {
          ruleId: rule.id,
          ruleName: rule.name,
          storeId: rule.storeId,
          assignedUserId: rule.assignedUserId,
          handling: rule.handling,
          aiContext: rule.aiContext ?? null,
          aiGuardrails: rule.aiGuardrails ?? null,
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
      case 'ad_id':
        if (normalise(context.adId) === expected) matched.push({ rule, specificity: EXACT_MATCH });
        break;
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
    const matchValue = typeof rule.matchValue === 'string' ? rule.matchValue.trim() : '';
    if (!id || !name || !matchValue || seen.has(id)) return [];
    if (
      !['ad_id', 'ad_set_id', 'ad_set_name', 'campaign_name', 'tag'].includes(rule.matchField ?? '')
    ) {
      return [];
    }
    if (!['ai', 'human'].includes(rule.handling ?? '')) return [];
    seen.add(id);
    return [{
      id,
      name,
      enabled: rule.enabled !== false,
      priority: Number.isInteger(rule.priority) ? Math.max(0, Math.min(1000, rule.priority!)) : 100,
      matchField: rule.matchField!,
      matchValue,
      storeId: typeof rule.storeId === 'string' && rule.storeId ? rule.storeId : null,
      assignedUserId: typeof rule.assignedUserId === 'string' && rule.assignedUserId ? rule.assignedUserId : null,
      handling: rule.handling!,
      aiContext: typeof rule.aiContext === 'string' && rule.aiContext.trim() ? rule.aiContext.trim().slice(0, AI_CONTEXT_MAX) : null,
      aiGuardrails: typeof rule.aiGuardrails === 'string' && rule.aiGuardrails.trim() ? rule.aiGuardrails.trim().slice(0, AI_GUARDRAILS_MAX) : null,
    }];
  });
}

function normalise(value?: string) {
  return (value ?? '').trim().toLocaleLowerCase('en-IN');
}
