import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { QualificationService } from './qualification.service';

/**
 * The omnichannel headline numbers: how many people arrived, through which
 * channel, how far each of them got.
 *
 * Three rules shape every figure below.
 *
 * **Each number is its own aggregate.** None of them is derived by counting a
 * page of rows. A screen that computes "visits" from `rows.filter(...)` agrees
 * with the database only until the list is paginated, and then reports whatever
 * fits on one page as the truth.
 *
 * **A count nobody can produce is `null`, never `0`.** Zero means "we looked and
 * there were none". Null means "this tenant has no such data" — an organisation
 * with no ad account has null Meta leads, not a zero that reads like a failing
 * campaign.
 *
 * **The vocabulary is the tenant's.** Intent bands come from their qualification
 * policy, so a clinic sees its own labels rather than a jeweller's. Nothing here
 * hardcodes an industry: `enquiries` counts recorded interest in catalogue items,
 * whatever the catalogue holds.
 */

/** How the channels roll up. `LeadSource` is a Postgres enum; these are its members. */
const PAID_SOCIAL: Prisma.Enumerable<'meta_ads'> = ['meta_ads'];
const ORGANIC_SOCIAL = ['instagram'] as const;
const MESSAGING = ['whatsapp'] as const;

/** Default reporting window. Long enough that a quiet branch is not all zeroes. */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 730;

export interface OmnichannelSummary {
  windowDays: number;
  since: string;
  storeIds: string[];
  totals: {
    leads: number;
    visits: number;
    enquiries: number;
    /** Customers first recorded inside the window, not the whole book. */
    customers: number;
    newLeadsWithVisits: number;
  };
  bySource: { source: string; label: string; count: number }[];
  channels: {
    paidSocial: number;
    organicSocial: number;
    messaging: number;
    website: number;
    walkIn: number;
    phone: number;
    referral: number;
    imported: number;
  };
  /** Null when the tenant has never run qualification — not an empty chart of zeroes. */
  intent: { key: string; label: string; count: number }[] | null;
  intentAssessed: number;
  funnel: { key: string; label: string; count: number | null }[];
}

@Injectable()
export class OmnichannelKpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly qualification: QualificationService,
  ) {}

  async summary(
    user: AuthUser,
    opts: { storeId?: string; days?: number } = {},
  ): Promise<OmnichannelSummary> {
    const windowDays = Math.min(Math.max(opts.days ?? DEFAULT_DAYS, 1), MAX_DAYS);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // Throws if the caller named a branch outside their scope, rather than
    // quietly widening to everything they can see.
    const storeIds = this.scope.effectiveStoreIds(user, opts.storeId);
    const org = user.organisationId;
    const inStores = { in: storeIds };

    const leadWhere: Prisma.LeadWhereInput = {
      organisationId: org,
      storeId: inStores,
      createdAt: { gte: since },
    };
    const visitWhere: Prisma.CheckInWhereInput = {
      organisationId: org,
      storeId: inStores,
      timeIn: { gte: since },
    };

    const [
      leads,
      visits,
      enquiries,
      customers,
      sourceGroups,
      bandRows,
      converted,
      conversations,
    ] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.checkIn.count({ where: visitWhere }),
      this.prisma.productInteraction.count({
        where: { organisationId: org, storeId: inStores, occurredAt: { gte: since } },
      }),
      /*
       * Customers ACQUIRED in the window, not customers on the books.
       *
       * This had no `createdAt` bound while every figure beside it did, so
       * moving the selector from 12 months to 30 days dropped leads, visits and
       * enquiries and left this one identical — a tile under a heading reading
       * "30 days" claiming the whole book was won in a month.
       */
      this.prisma.party.count({
        where: {
          organisationId: org,
          storeId: inStores,
          types: { has: 'customer' },
          createdAt: { gte: since },
        },
      }),
      this.prisma.lead.groupBy({
        by: ['source'],
        where: leadWhere,
        _count: { _all: true },
      }),
      // Latest assessment per lead would need a window function; the band mix
      // across assessments in the window is the honest, cheap answer and is
      // labelled as such on the screen.
      this.prisma.leadQualification.groupBy({
        by: ['band'],
        where: {
          organisationId: org,
          createdAt: { gte: since },
          lead: { storeId: inStores },
        },
        _count: { _all: true },
      }),
      this.prisma.lead.count({ where: { ...leadWhere, outcome: 'won' } }),
      // Scoped by organisation, not branch: `Conversation.storeId` is null until
      // the sender resolves to a customer, and a branch filter would silently
      // report every unresolved thread as "no conversations".
      this.prisma.conversation.count({
        where: { organisationId: org, createdAt: { gte: since } },
      }),
    ]);

    const bySourceCount = new Map(sourceGroups.map((g) => [String(g.source), g._count._all]));
    const sum = (keys: readonly string[]) =>
      keys.reduce((n, k) => n + (bySourceCount.get(k) ?? 0), 0);

    // "New leads that also walked in" — the offline half of the attribution
    // story. Counted by matching the lead's party against a visit in the same
    // window, because a lead with no party has no visit to match.
    const newLeadsWithVisits = await this.countLeadsWithVisits(org, storeIds, since);

    const policy = await this.resolveBands(org);
    const intentAssessed = bandRows.reduce((n, r) => n + r._count._all, 0);

    return {
      windowDays,
      since: since.toISOString(),
      storeIds,
      totals: { leads, visits, enquiries, customers, newLeadsWithVisits },
      bySource: sourceGroups
        .map((g) => ({
          source: String(g.source),
          label: SOURCE_LABELS[String(g.source)] ?? String(g.source),
          count: g._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      channels: {
        paidSocial: sum(PAID_SOCIAL as readonly string[]),
        organicSocial: sum(ORGANIC_SOCIAL),
        messaging: sum(MESSAGING),
        website: bySourceCount.get('website') ?? 0,
        walkIn: bySourceCount.get('walk_in') ?? 0,
        phone: bySourceCount.get('phone') ?? 0,
        referral: bySourceCount.get('referral') ?? 0,
        imported: bySourceCount.get('imported') ?? 0,
      },
      intent: intentAssessed
        ? policy.map((b) => ({
            key: b.key,
            label: b.label,
            count: bandRows.find((r) => r.band === b.key)?._count._all ?? 0,
          }))
        : null,
      intentAssessed,
      funnel: [
        { key: 'conversations', label: 'Conversations', count: conversations },
        { key: 'leads', label: 'Leads', count: leads },
        { key: 'enquiries', label: 'Enquiries', count: enquiries },
        { key: 'visits', label: 'Visits', count: visits },
        { key: 'converted', label: 'Converted', count: converted },
      ],
    };
  }

  /**
   * Leads created in the window whose person also checked in during it.
   *
   * Two queries rather than a join because the lead and the visit are linked
   * through `partyId`, which is nullable on both: a SQL join would silently drop
   * every walk-in recorded without a party, and reading that as "no visits" is
   * worse than the extra round trip.
   */
  private async countLeadsWithVisits(org: string, storeIds: string[], since: Date) {
    const visitParties = await this.prisma.checkIn.findMany({
      where: {
        organisationId: org,
        storeId: { in: storeIds },
        timeIn: { gte: since },
        partyId: { not: null },
      },
      select: { partyId: true },
      distinct: ['partyId'],
    });
    const ids = visitParties.map((v) => v.partyId!).filter(Boolean);
    if (!ids.length) return 0;

    return this.prisma.lead.count({
      where: {
        organisationId: org,
        storeId: { in: storeIds },
        createdAt: { gte: since },
        partyId: { in: ids },
      },
    });
  }

  /**
   * The tenant's own band labels. Read through `QualificationService` rather than
   * off the organisation row directly, so there is one place that knows where the
   * policy lives and what a missing one falls back to.
   */
  private async resolveBands(org: string) {
    const policy = await this.qualification.policyFor(org);
    return policy.bands.map((b) => ({ key: b.key, label: b.label }));
  }
}

/**
 * Display names for the enum members. A label belongs next to the value it
 * names; leaving it to each client is how two screens end up disagreeing about
 * what `meta_ads` is called.
 */
const SOURCE_LABELS: Record<string, string> = {
  walk_in: 'Walk-in',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  website: 'Website',
  instagram: 'Instagram',
  referral: 'Referral',
  meta_ads: 'Meta Ads',
  imported: 'Imported',
};
