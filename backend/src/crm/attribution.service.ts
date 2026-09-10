import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';

/**
 * Attribution (Phase A10) — where a customer came from, and what that was worth.
 *
 * THE DISTINCTION THIS SERVICE EXISTS TO PROTECT:
 *
 *   DECLARED  — a human picked "Instagram" from a dropdown. Cheap, always
 *               available, and frequently wrong: the salesperson guesses.
 *   MEASURED  — a click id or tracked link carried the campaign in. Rare today,
 *               trustworthy, and the only thing a spend decision should rest on.
 *   INFERRED  — a rule matched. Useful, and must never be mistaken for measured.
 *
 * They are stored in the same table with an `evidence` column rather than being
 * silently merged, so a "campaign ROI" report can be honest about which half of
 * its numbers somebody typed in. Merging them is the single most common way an
 * attribution system starts lying: it produces a confident revenue figure for a
 * campaign whose only evidence is a salesperson's recollection.
 *
 * NOTHING HERE INVENTS A SOURCE. A lead with no stated source produces an
 * `unknown` touch — a real, queryable statement that we do not know — rather
 * than defaulting to organic, which would quietly credit "organic" for every
 * campaign the business ever ran.
 *
 * WHAT IS DELIBERATELY NOT BUILT: AdSet and Ad are not tables. No provider
 * integration exists to populate them, and modelling a hierarchy whose rows can
 * only ever be typed by hand would be building the reporting layer before the
 * data. External ids ride as opaque strings on the touch until a verified
 * provider connection can fill them.
 */

/** Ordered strongest-first: a measured touch outranks a declared one. */
const EVIDENCE_RANK: Record<string, number> = { measured: 3, inferred: 2, declared: 1 };

export interface RecordTouchInput {
  partyId?: string | null;
  leadId?: string | null;
  /** 'ad' | 'organic' | 'referral' | 'direct' | 'unknown' */
  channel: string;
  source?: string | null;
  medium?: string | null;
  campaignId?: string | null;
  externalCampaignId?: string | null;
  externalAdSetId?: string | null;
  externalAdId?: string | null;
  clickId?: string | null;
  evidence?: 'measured' | 'declared' | 'inferred';
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
  /**
   * Stable identity of this interaction. When supplied, the touch is written at
   * most once per (organisation, key) — a provider retry or a second message
   * carrying the same click cannot double-count it. Omit for touches with no
   * natural provider identity (a salesperson's declared source), which are never
   * deduped.
   */
  dedupeKey?: string | null;
}

@Injectable()
export class AttributionService {
  private readonly log = new Logger(AttributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * Record a touch.
   *
   * `position` is computed rather than accepted: whether this is the first touch
   * is a fact about what already exists, not something a caller can assert. The
   * first touch for a subject stays first forever — that is what makes
   * first-touch attribution stable when a customer comes back a year later.
   */
  async recordTouch(organisationId: string, input: RecordTouchInput) {
    if (!input.partyId && !input.leadId) return null;

    const prior = await this.prisma.attributionTouch.count({
      where: {
        organisationId,
        ...(input.partyId ? { partyId: input.partyId } : { leadId: input.leadId }),
      },
    });

    try {
      return await this.prisma.attributionTouch.create({
      data: {
        organisationId,
        partyId: input.partyId ?? null,
        leadId: input.leadId ?? null,
        channel: input.channel,
        source: input.source ?? null,
        medium: input.medium ?? null,
        campaignId: input.campaignId ?? null,
        externalCampaignId: input.externalCampaignId ?? null,
        externalAdSetId: input.externalAdSetId ?? null,
        externalAdId: input.externalAdId ?? null,
        clickId: input.clickId ?? null,
        position: prior === 0 ? 'first_touch' : 'mid',
        // Defaults to `declared`, the weakest claim. Anything stronger has to be
        // asserted explicitly by a caller that actually measured something.
        evidence: input.evidence ?? 'declared',
        occurredAt: input.occurredAt ?? new Date(),
        metadata: input.metadata,
        dedupeKey: input.dedupeKey ?? null,
      },
      });
    } catch (err) {
      // The unique index on (organisationId, dedupeKey) already holds this
      // interaction. Losing that race IS the correct outcome — the touch exists
      // exactly once — so this returns the winner rather than raising.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        input.dedupeKey
      ) {
        return this.prisma.attributionTouch.findFirst({
          where: { organisationId, dedupeKey: input.dedupeKey },
        });
      }
      throw err;
    }
  }

  /**
   * Record the touch implied by a newly created lead.
   *
   * Best-effort and never throws: a lead must be saved whether or not its
   * marketing provenance can be. Called from LeadsService after the lead exists.
   */
  async recordLeadSource(
    organisationId: string,
    lead: { id: string; partyId: string | null; source: string | null; createdAt?: Date },
  ): Promise<void> {
    try {
      const declared = (lead.source ?? '').trim();
      await this.recordTouch(organisationId, {
        leadId: lead.id,
        partyId: lead.partyId,
        // A source the business records on the lead form is a CHANNEL claim, and
        // the mapping from their vocabulary to ours is not something to guess:
        // anything not recognisably an ad channel is recorded as its own source
        // string under a neutral channel rather than being forced into a bucket.
        channel: declared ? channelFor(declared) : 'unknown',
        source: declared || null,
        evidence: 'declared',
        occurredAt: lead.createdAt,
        metadata: { via: 'lead_form' },
      });
    } catch (e) {
      this.log.warn(`attribution touch not recorded for lead ${lead.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Credit a sale to the touches that preceded it.
   *
   * Runs BOTH models and stores both conclusions, rather than picking one:
   * first-touch answers "what brought them to us", last-touch answers "what
   * closed them", and a business needs different ones on different days. Storing
   * only one would force a re-derivation the data may no longer support.
   *
   * Touches AFTER the sale are excluded. Crediting a campaign for revenue that
   * arrived before the campaign ran is the most flattering possible bug and one
   * of the easiest to ship.
   */
  async creditSale(
    organisationId: string,
    sale: { id: string; partyId: string | null; docDate: Date },
  ): Promise<{ credited: number; reason?: string }> {
    if (!sale.partyId) return { credited: 0, reason: 'The sale is not linked to a customer.' };

    const touches = await this.prisma.attributionTouch.findMany({
      where: { organisationId, partyId: sale.partyId, occurredAt: { lte: sale.docDate } },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, channel: true },
    });
    if (touches.length === 0) {
      return { credited: 0, reason: 'No recorded touch precedes this sale, so nothing can be credited.' };
    }

    const first = touches[0];
    const last = touches[touches.length - 1];
    const single = first.id === last.id;

    // A customer with ONE recorded touch is a case worth naming, because getting
    // it wrong is invisible. That touch is simultaneously the first and the
    // last; crediting it as `first_touch` alone would make a last-touch report
    // silently omit every single-touch customer — which, early on, is most of
    // them. The report would look plausible and undercount badly.
    await this.prisma.$transaction([
      this.prisma.attributionTouch.update({
        where: { id: first.id },
        data: { saleId: sale.id, creditModel: single ? 'both' : 'first_touch' },
      }),
      ...(single
        ? []
        : [
            this.prisma.attributionTouch.update({
              where: { id: last.id },
              data: { saleId: sale.id, creditModel: 'last_touch' },
            }),
          ]),
    ]);

    return { credited: single ? 1 : 2 };
  }

  /**
   * The attribution picture for one customer — what Customer 360 shows.
   *
   * Returns an explicit `unattributed` state rather than an empty object. "We
   * have no idea where this customer came from" is the single most common true
   * answer in a business that has just started tracking, and it must render as
   * itself rather than as a blank panel that looks broken.
   */
  async forParty(user: AuthUser, partyId: string) {
    const touches = await this.prisma.attributionTouch.findMany({
      where: { organisationId: user.organisationId, partyId },
      orderBy: { occurredAt: 'asc' },
      include: { campaign: { select: { id: true, name: true, type: true } } },
    });

    if (touches.length === 0) {
      return {
        status: 'unattributed' as const,
        reason:
          'Nothing has been recorded about where this customer came from. Capturing a source on the lead form, or connecting an advertising account, will start filling this in.',
        touches: [],
        firstTouch: null,
        lastTouch: null,
        revenue: null,
      };
    }

    const known = touches.filter((t) => t.channel !== 'unknown');
    const firstTouch = known[0] ?? null;
    const lastTouch = known[known.length - 1] ?? null;

    // Revenue is read from sales actually credited to these touches, never from
    // "all this customer's sales" — a customer can buy for reasons that have
    // nothing to do with the campaign that first reached them.
    const creditedSaleIds = touches.map((t) => t.saleId).filter((v): v is string => !!v);
    const revenue = creditedSaleIds.length
      ? await this.prisma.sale.aggregate({
          where: {
            id: { in: creditedSaleIds },
            organisationId: user.organisationId,
            ...this.scope.storeFilter(user),
          },
          _sum: { totalAmount: true },
          _count: { _all: true },
        })
      : null;

    return {
      status: known.length ? ('attributed' as const) : ('unattributed' as const),
      reason: known.length
        ? null
        : 'Touches were recorded but none names a source, so no origin can be claimed for this customer.',
      touches: touches.map((t) => ({
        id: t.id,
        channel: t.channel,
        source: t.source,
        medium: t.medium,
        position: t.position,
        evidence: t.evidence,
        campaign: t.campaign,
        externalCampaignId: t.externalCampaignId,
        externalAdSetId: t.externalAdSetId,
        externalAdId: t.externalAdId,
        creditModel: t.creditModel,
        occurredAt: t.occurredAt,
      })),
      firstTouch: firstTouch && {
        channel: firstTouch.channel,
        source: firstTouch.source,
        campaign: firstTouch.campaign,
        evidence: firstTouch.evidence,
        occurredAt: firstTouch.occurredAt,
      },
      lastTouch: lastTouch && {
        channel: lastTouch.channel,
        source: lastTouch.source,
        campaign: lastTouch.campaign,
        evidence: lastTouch.evidence,
        occurredAt: lastTouch.occurredAt,
      },
      revenue: revenue
        ? {
            sales: revenue._count._all,
            total: (revenue._sum.totalAmount ?? new Prisma.Decimal(0)).toFixed(2),
            note: 'Only sales explicitly credited to a recorded touch are counted.',
          }
        : null,
    };
  }

  /**
   * Campaign-level rollup.
   *
   * Reports measured and declared revenue as SEPARATE figures. One blended
   * number would be the lie this whole service is built to avoid — a marketing
   * budget moved on the strength of "₹40L attributed" deserves to know that ₹38L
   * of it was somebody choosing an option from a dropdown.
   */
  async campaignPerformance(user: AuthUser, model: 'first_touch' | 'last_touch' = 'last_touch') {
    const touches = await this.prisma.attributionTouch.findMany({
      where: {
        organisationId: user.organisationId,
        saleId: { not: null },
        // `both` is a single touch that is the first AND the last. It belongs in
        // either report — excluding it is how a single-touch customer disappears.
        creditModel: { in: [model, 'both'] },
      },
      select: {
        campaignId: true,
        source: true,
        channel: true,
        evidence: true,
        campaign: { select: { id: true, name: true, spend: true } },
        sale: { select: { id: true, totalAmount: true, storeId: true } },
      },
    });

    const allowedStores = new Set(user.storeIds);
    const buckets = new Map<
      string,
      {
        campaignId: string | null;
        label: string;
        spend: string | null;
        sales: number;
        measuredRevenue: Prisma.Decimal;
        declaredRevenue: Prisma.Decimal;
      }
    >();

    for (const t of touches) {
      // Store scope is applied to the SALE: revenue from a branch this user
      // cannot see must not appear in their totals.
      if (!t.sale || (!user.allStores && !allowedStores.has(t.sale.storeId))) continue;
      const key = t.campaignId ?? `source:${t.source ?? t.channel}`;
      const bucket =
        buckets.get(key) ??
        {
          campaignId: t.campaignId,
          label: t.campaign?.name ?? t.source ?? t.channel,
          spend: t.campaign?.spend ? t.campaign.spend.toFixed(2) : null,
          sales: 0,
          measuredRevenue: new Prisma.Decimal(0),
          declaredRevenue: new Prisma.Decimal(0),
        };
      bucket.sales += 1;
      if (t.evidence === 'measured') {
        bucket.measuredRevenue = bucket.measuredRevenue.plus(t.sale.totalAmount);
      } else {
        bucket.declaredRevenue = bucket.declaredRevenue.plus(t.sale.totalAmount);
      }
      buckets.set(key, bucket);
    }

    return {
      model,
      rows: [...buckets.values()]
        .map((b) => ({
          campaignId: b.campaignId,
          label: b.label,
          spend: b.spend,
          sales: b.sales,
          measuredRevenue: b.measuredRevenue.toFixed(2),
          declaredRevenue: b.declaredRevenue.toFixed(2),
          /**
           * Return on spend is offered ONLY against measured revenue and only
           * when spend is known. A ROAS computed over salesperson-declared
           * sources is a number that looks rigorous and is not.
           */
          measuredRoas:
            b.spend && Number(b.spend) > 0
              ? (Number(b.measuredRevenue) / Number(b.spend)).toFixed(2)
              : null,
        }))
        .sort((a, b) => Number(b.measuredRevenue) + Number(b.declaredRevenue) - (Number(a.measuredRevenue) + Number(a.declaredRevenue))),
      note: 'Measured revenue comes from a tracked click. Declared revenue is what someone selected by hand. They are never added together.',
    };
  }

  /** Strongest available evidence for a subject — used when two touches disagree. */
  static strongest<T extends { evidence: string }>(touches: T[]): T | null {
    return (
      [...touches].sort((a, b) => (EVIDENCE_RANK[b.evidence] ?? 0) - (EVIDENCE_RANK[a.evidence] ?? 0))[0] ?? null
    );
  }
}

/**
 * Map a declared source string onto a channel bucket.
 *
 * Only maps what is unambiguous. Anything unrecognised becomes `referral` —
 * literally "somebody sent them" — rather than being forced into `ad`, because
 * an unrecognised word is not evidence of advertising spend.
 */
function channelFor(source: string): string {
  const s = source.toLowerCase();
  if (/(instagram|facebook|meta|google|ads?|campaign)/.test(s)) return 'ad';
  if (/(walk[_\s-]?in|store|counter)/.test(s)) return 'direct';
  if (/(referr?al|friend|family|word)/.test(s)) return 'referral';
  if (/(website|web|organic|search|seo)/.test(s)) return 'organic';
  return 'referral';
}
