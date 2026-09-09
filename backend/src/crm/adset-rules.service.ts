import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { updateOrgSettings } from '../config/org-settings';

/**
 * What a rule matches on.
 *
 * `ad_id` is the one a Click-to-WhatsApp click can actually satisfy today: Meta
 * puts the AD id in the referral and nothing else, so a tenant pasting ad ids
 * from Ads Manager gets correct routing with no app review. `ad_set_id` and
 * `ad_set_name` stay supported for a Lead Ads / Marketing API adapter that can
 * supply them — until then they simply never match, which is the honest result.
 */
export type AdSetMatchField = 'ad_id' | 'ad_set_id' | 'ad_set_name' | 'tag';
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
}

export interface AdSetRoutingContext {
  /** Provider ad id — the only identifier a CTWA referral supplies. */
  adId?: string;
  adSetId?: string;
  adSetName?: string;
  tags?: string[];
}

export interface AdSetRoutingDecision {
  ruleId: string;
  ruleName: string;
  storeId: string | null;
  assignedUserId: string | null;
  handling: AdSetHandling;
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
        }
      : null;
  }
}

export function resolveAdSetRule(rules: AdSetAutomationRule[], context: AdSetRoutingContext) {
  const byPriority = [...rules].filter((rule) => rule.enabled).sort((a, b) => b.priority - a.priority);
  const tags = (context.tags ?? []).map(normalise);
  return byPriority.find((rule) => {
    const expected = normalise(rule.matchValue);
    if (rule.matchField === 'ad_id') return normalise(context.adId) === expected;
    if (rule.matchField === 'ad_set_id') return normalise(context.adSetId) === expected;
    if (rule.matchField === 'ad_set_name') return normalise(context.adSetName).includes(expected);
    return tags.includes(expected);
  }) ?? null;
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
    if (!['ad_id', 'ad_set_id', 'ad_set_name', 'tag'].includes(rule.matchField ?? '')) return [];
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
    }];
  });
}

function normalise(value?: string) {
  return (value ?? '').trim().toLocaleLowerCase('en-IN');
}
