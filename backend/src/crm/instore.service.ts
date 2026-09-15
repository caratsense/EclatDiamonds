import { BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped, partyWorkedBy } from '../common/sales-scope';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from './activity.service';
import { Customer360Service } from './customer360.service';
import { IdentityService } from './identity.service';
import { StorageService } from '../storage/storage.service';
import { saveCapturedPhoto } from '../storage/capture-photo';
import {
  businessDate,
  dateOnly,
  formatHHMMInTz,
  startOfDayAgoInTz,
  startOfDayInTz,
} from '../common/tz.util';

/**
 * The in-store / field application.
 *
 * Almost nothing here is new behaviour: the customer profile, identity
 * resolution and product-interaction recording already exist and are reused
 * rather than reimplemented, because a second copy of "which store may this user
 * see" is how the two copies eventually disagree.
 *
 * Two things genuinely did not exist and are added here:
 *
 *   1. PARTIAL contact search. `IdentityService.resolve` matches an exact
 *      normalized value, which is right for a webhook and wrong for a
 *      salesperson at a counter typing the last three digits a customer just
 *      read out.
 *   2. Item lookup by scanned code, which has to answer "no such item" as a
 *      first-class result rather than an error, because an unknown barcode is
 *      an ordinary thing to scan.
 *
 * Everything is tenant-scoped and branch-scoped. Nothing in this file is
 * jewellery-specific: an "item" is whatever the tenant's catalogue holds, and
 * the vocabulary a screen shows comes from the industry pack.
 */

/**
 * The values `CheckinPurpose` actually holds. Anything else a tenant configures
 * goes to `purposeCode` rather than being forced into one of these.
 */
const JEWELLERY_PURPOSES = new Set([
  'bridal',
  'investment',
  'repair',
  'quote_followup',
  'browsing',
  'scheme',
  'other',
]);

/** Search needs enough to be a search. Two characters would scan the tenant. */
const MIN_SEARCH = 3;
const MAX_RESULTS = 25;

/**
 * What a visit LOOKS like to someone glancing at a list, from the outcome the
 * counter recorded.
 *
 * Three states, because those are the three a salesperson acts on differently:
 * a sale is done, a walk-out is a lost customer worth a call, and everything
 * else is still open. `quote_given` and `follow_up` are deliberately "open" —
 * they are promises, not conclusions.
 */
function visitStatus(outcome: string): 'converted' | 'walked_out' | 'open' {
  if (outcome === 'sale_closed') return 'converted';
  if (outcome === 'left') return 'walked_out';
  return 'open';
}

/**
 * The tenant's own reason an item did not convert, as it was recorded.
 *
 * Read defensively: `metadata` is a JSON column, so it can hold anything an
 * older write or an import put there. Anything that is not a string is dropped
 * rather than stringified — "[object Object]" on a manager's report is worse
 * than a blank.
 */
function readDropOffReason(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).dropOffReason;
  return typeof value === 'string' && value.trim() ? value : null;
}

@Injectable()
export class InStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly identity: IdentityService,
    private readonly customer360: Customer360Service,
    private readonly activity: ActivityService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The lead feed a salesperson opens on the floor.
   *
   * Branch-scoped by the caller's own stores, newest first, with the badges the
   * screen needs resolved in the same query rather than N follow-ups.
   */
  async leadFeed(
    user: AuthUser,
    opts: { storeId?: string; stage?: string; source?: string; limit?: number; cursor?: string } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    if (opts.storeId) this.scope.assertStoreAllowed(user, opts.storeId);

    const where: Prisma.LeadWhereInput = {
      organisationId: user.organisationId,
      ...this.scope.storeFilter(user),
      ...(isSalesScoped(user) ? { ownerId: user.id } : {}),
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      ...(opts.stage ? { stage: opts.stage as never } : {}),
      ...(opts.source ? { source: opts.source as never } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          ref: true,
          stage: true,
          source: true,
          interest: true,
          createdAt: true,
          lastActivity: true,
          customerName: true,
          phone: true,
          owner: { select: { id: true, name: true } },
          store: { select: { id: true, name: true } },
          party: {
            select: {
              id: true,
              name: true,
              createdAt: true,
              code: true,
              whatsapp: true,
            },
          },
        },
      }),
      // The uncapped total, so the header can say "45,189" honestly instead of
      // the length of this page.
      this.prisma.lead.count({ where }),
    ]);

    const page = rows.slice(0, limit);
    return {
      total,
      items: page.map((l) => ({
        id: l.id,
        ref: l.ref,
        stage: l.stage,
        source: l.source,
        interest: l.interest,
        createdAt: l.createdAt,
        lastActivity: l.lastActivity,
        customerName: l.party?.name ?? l.customerName,
        customerId: l.party?.code ?? null,
        partyId: l.party?.id ?? null,
        customerSince: l.party?.createdAt ?? null,
        hasWhatsApp: Boolean(l.party?.whatsapp),
        owner: l.owner,
        store: l.store,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]?.id : null,
    };
  }

  /**
   * Find a walk-in from a fragment: part of a number, a name, or a customer code.
   *
   * Digits are searched against the NORMALIZED contact value, so "930" finds
   * +91 93091 37416 the way the salesperson expects. Non-digits search the name
   * and the tenant's own customer code.
   */
  async search(user: AuthUser, query: string) {
    const q = (query ?? '').trim();
    if (q.length < MIN_SEARCH) {
      throw new BadRequestException(`Type at least ${MIN_SEARCH} characters to search.`);
    }

    /*
     * A phone fragment is digits and phone punctuation, nothing else.
     *
     * The first version of this asked "does it contain at least three digits",
     * which sent a customer code like `CUS-1001` down the phone path and found
     * nobody — the tenant's own identifiers usually end in digits. Requiring the
     * WHOLE query to be dialable is what separates "930" from "CUS-1001".
     */
    const digits = q.replace(/\D/g, '');
    const byDigits = /^[\d\s+()-]+$/.test(q) && digits.length >= MIN_SEARCH;

    const parties = await this.prisma.party.findMany({
      where: {
        organisationId: user.organisationId,
        // A salesperson finds their own customers; a phone search is not a way
        // to page through a colleague's book.
        ...(isSalesScoped(user) ? partyWorkedBy(user.id) : {}),
        // Not offered at the counter. A salesperson picking an archived contact
        // from a lookup is how one quietly returns to active use.
        archivedAt: null,
        ...(byDigits
          ? {
              contactPoints: {
                some: {
                  organisationId: user.organisationId,
                  valueNormalized: { contains: digits },
                },
              },
            }
          : {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { code: { equals: q, mode: 'insensitive' } },
              ],
            }),
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_RESULTS,
      select: {
        id: true,
        name: true,
        code: true,
        phone: true,
        whatsapp: true,
        city: true,
        createdAt: true,
        storeId: true,
        store: { select: { id: true, name: true } },
        /*
         * Only an enquiry belonging to a branch this caller actually works at.
         *
         * The customer stays findable across the whole tenant on purpose — a
         * chain's customer who bought in Surat and walks into Mumbai must be
         * recognised, and narrowing the party search to one branch would make
         * every such customer look new. What does NOT travel is the other
         * branch's open enquiry: that is their pipeline, and showing it here
         * invites a salesperson to work someone else's deal.
         */
        leads: {
          where: { closedAt: null, storeId: { in: user.storeIds } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, ref: true, stage: true, source: true, interest: true, createdAt: true },
        },
      },
    });

    return {
      query: q,
      matchedOn: byDigits ? ('contact' as const) : ('name' as const),
      /**
       * An empty result is a normal outcome at a counter, not an error: the
       * person in front of you may simply be new. The screen offers to create
       * them, which is why this returns `canCreate` rather than a 404.
       */
      canCreate: true,
      items: parties.map((p) => ({
        partyId: p.id,
        name: p.name,
        customerId: p.code,
        contact: p.whatsapp ?? p.phone,
        city: p.city,
        customerSince: p.createdAt,
        store: p.store,
        activeLead: p.leads[0] ?? null,
      })),
    };
  }

  /** The 360 view, unchanged — the existing service already answers this. */
  async profile(user: AuthUser, partyId: string) {
    return this.customer360.profile(user, partyId);
  }

  /**
   * What did they scan?
   *
   * An unknown code is a RESULT, not an exception. A salesperson scans whatever
   * is in their hand, including tags from a supplier that were never catalogued,
   * and a 404 would make the app look broken at exactly the wrong moment. The
   * caller can still record the interest against the raw code.
   */
  async lookupItem(user: AuthUser, code: string) {
    const value = (code ?? '').trim();
    if (!value) throw new BadRequestException('Scan or type a code first.');

    const product = await this.prisma.product.findFirst({
      where: {
        organisationId: user.organisationId,
        OR: [{ sku: value }, { legacyId: value }],
      },
      select: {
        id: true,
        sku: true,
        name: true,
        category: true,
        availability: true,
        imageUrl: true,
      },
    });

    if (product) return { found: true as const, item: product, code: value };

    // Stock tags are a second, equally legitimate thing to scan.
    const stock = await this.prisma.stockItem.findFirst({
      where: { organisationId: user.organisationId, OR: [{ sku: value }, { legacyId: value }] },
      select: { id: true, sku: true, productId: true, status: true },
    });
    if (stock?.productId) {
      const linked = await this.prisma.product.findFirst({
        where: { id: stock.productId, organisationId: user.organisationId },
        select: { id: true, sku: true, name: true, category: true, availability: true, imageUrl: true },
      });
      if (linked) return { found: true as const, item: linked, code: value, stockTag: stock.sku };
    }

    return { found: false as const, code: value };
  }

  /**
   * Log a walk-in.
   *
   * One visit, any number of enquiries inside it — which is the whole point of
   * the screen: a customer who looks at three things and buys one is the normal
   * case, and recording that as three separate visits loses the fact that it was
   * one conversation.
   *
   * Written in a single transaction so a half-recorded visit cannot exist.
   */
  async recordVisit(
    user: AuthUser,
    input: {
      partyId: string;
      storeId?: string;
      purpose?: string;
      outcome?: string;
      notes?: string;
      attendedByUserId?: string;
      /** Tenant vocabulary: occasion, counter, department — whatever the pack defines. */
      fields?: Record<string, unknown>;
      /**
       * A `data:image/...;base64,` frame taken at the counter.
       *
       * A picture of the visit, not an identification: who this is comes from
       * the customer record the visit is attached to, and nothing compares the
       * image to anything. Optional, and a failure to store it never stops the
       * visit being recorded.
       */
      photo?: string;
      enquiries?: {
        productId?: string;
        sku?: string;
        converted?: boolean;
        quantity?: number;
        notes?: string;
        /** Why it did not convert. Configured per tenant; never a fixed list here. */
        dropOffReason?: string;
      }[];
    },
  ) {
    const party = await this.prisma.party.findFirst({
      where: { id: input.partyId, organisationId: user.organisationId },
      select: { id: true, name: true, storeId: true },
    });
    if (!party) throw new NotFoundException('That customer does not exist.');

    // Same rule as recordInteraction: infer the branch only when there is
    // exactly one possible answer. Head office has dozens, and guessing files a
    // visit against a branch the customer never entered.
    const storeId =
      input.storeId ?? (user.storeIds.length === 1 ? user.storeIds[0] : party.storeId ?? null);
    if (!storeId) {
      throw new BadRequestException('Choose which branch this visit happened at.');
    }
    this.scope.assertStoreAllowed(user, storeId);

    const enquiries = (input.enquiries ?? []).slice(0, 20);
    // One query for the whole basket. This used to be one round trip per
    // enquiry — up to twenty sequential reads before the transaction even
    // opened, with a customer standing at the counter.
    const productIds = [...new Set(enquiries.map((e) => e.productId).filter(Boolean))] as string[];
    if (productIds.length) {
      const owned = await this.prisma.product.count({
        where: { id: { in: productIds }, organisationId: user.organisationId },
      });
      if (owned !== productIds.length) {
        throw new BadRequestException('One of the items does not belong to this tenant.');
      }
    }

    // A salesperson records their own visits, never one under a colleague's name.
    if (isSalesScoped(user) && input.attendedByUserId && input.attendedByUserId !== user.id) {
      throw new ForbiddenException('You can only record your own visits.');
    }
    const attendedBy = input.attendedByUserId ?? user.id;
    let staffName = user.name;
    if (input.attendedByUserId) {
      const staff = await this.prisma.user.findFirst({
        where: { id: input.attendedByUserId, organisationId: user.organisationId },
        select: { name: true },
      });
      if (!staff) throw new BadRequestException('That staff member is not in this organisation.');
      // The name comes from the user record, never from the request — a client
      // that could choose the display name could file a visit under a colleague.
      staffName = staff.name;
    }

    const converted = enquiries.some((e) => e.converted);
    const partially = converted && enquiries.some((e) => !e.converted);

    // Uploaded BEFORE the transaction opens. An upload can be slow on a shop's
    // connection, and holding a write transaction open across it would make one
    // person's photo block everyone else's visit.
    const photoUrl = await saveCapturedPhoto(
      this.storage,
      user.organisationId,
      'visits',
      `${party.id}-${Date.now()}`,
      input.photo,
    );

    return this.prisma.$transaction(async (tx) => {
      const checkIn = await tx.checkIn.create({
        data: {
          organisationId: user.organisationId,
          partyId: party.id,
          storeId,
          // Required by the existing model, and taken from the party so a
          // renamed customer does not orphan the visit's display name.
          customerName: party.name,
          timeIn: new Date(),
          /*
           * `attendedById` is the identity; `repId`/`repName` are the columns
           * the footfall log filters and displays on. Writing only the first
           * left every floor-recorded visit with a NULL repId — and
           * CheckinsService.list narrows a salesperson to `repId = user.id`, so
           * the person who recorded the visit was the one person who could not
           * see it afterwards.
           */
          repId: attendedBy,
          repName: staffName,

          /*
           * The enum stays `other` unless the tenant's configured purpose
           * happens to be one of its jewellery values. `purposeCode` carries the
           * real answer for every other industry — see the migration for why
           * both columns exist.
           */
          purpose: JEWELLERY_PURPOSES.has(input.purpose ?? '')
            ? (input.purpose as never)
            : ('other' as never),
          purposeCode: input.purpose ?? null,
          photoUrl,
          outcome: (converted ? 'sale_closed' : partially ? 'follow_up' : 'in_store') as never,
          notes: input.notes ?? null,
          attendedById: attendedBy,
          metadata: (input.fields ?? {}) as Prisma.InputJsonValue,
        },
      });

      for (const e of enquiries) {
        await tx.productInteraction.create({
          data: {
            organisationId: user.organisationId,
            storeId,
            partyId: party.id,
            productId: e.productId ?? null,
            // The raw code is kept even when it matched nothing, so an
            // uncatalogued item still shows up in what customers asked for.
            sku: e.productId ? null : (e.sku ?? null),
            // The visit this interest belongs to. Recorded rather than
            // reconstructed later from partyId and a time window, which would
            // attach one customer's enquiries to another customer's visit.
            checkInId: checkIn.id,
            kind: e.converted ? 'purchased' : 'shown',
            userId: attendedBy,
            channel: 'store',
            quantity: e.quantity ?? null,
            notes: e.notes ?? null,
            metadata: e.dropOffReason
              ? ({ dropOffReason: e.dropOffReason } as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
        });
      }

      await this.activity.record(
        {
          organisationId: user.organisationId,
          partyId: party.id,
          storeId,
          type: 'visit.recorded',
          channel: 'store',
          summary:
            `${party.name} visited` +
            (enquiries.length ? `, ${enquiries.length} enquiry item(s)` : '') +
            (partially ? ', partly converted' : converted ? ', converted' : ''),
          occurredAt: checkIn.createdAt,
          actorUserId: attendedBy,
        },
        tx,
      );

      return {
        checkInId: checkIn.id,
        enquiries: enquiries.length,
        converted,
        partiallyConverted: partially,
      };
    });
  }

  // =============================================================== visits

  /**
   * The visits recorded at this branch on one local day.
   *
   * A separate read from `GET /checkins`, which answers a different question:
   * that one is the whole footfall log, newest 200 rows, with no day boundary
   * and no record of what the customer actually asked about. The floor app needs
   * one day, at one branch, with the enquiries attached — and the enquiries are
   * only attachable because `ProductInteraction.checkInId` now records which
   * visit they belonged to instead of being matched back by a time window.
   *
   * "Today" is the STORE's calendar day. Anchoring it to the API server's clock
   * would make the list cover a different slice of the day depending on where
   * the container happens to run.
   */
  async visits(
    user: AuthUser,
    opts: { storeId?: string; date?: string; limit?: number; cursor?: string } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const tz = await this.scope.resolveTimezone(user, opts.storeId);

    // A supplied date is read as a calendar date AT THE STORE, so "2026-09-10"
    // means that day in the branch's own zone. Midday anchors it far enough from
    // either boundary that no zone offset can push it onto the adjacent day.
    const anchor = opts.date ? new Date(`${opts.date}T12:00:00Z`) : new Date();
    if (Number.isNaN(anchor.getTime())) {
      throw new BadRequestException('That is not a date this can read.');
    }
    const dayStart = startOfDayInTz(anchor, tz);
    const dayEnd = startOfDayAgoInTz(anchor, tz, -1);

    const where: Prisma.CheckInWhereInput = {
      organisationId: user.organisationId,
      ...this.scope.storeFilter(user, opts.storeId),
      timeIn: { gte: dayStart, lt: dayEnd },
      ...(isSalesScoped(user) ? { OR: [{ attendedById: user.id }, { repId: user.id }] } : {}),
    };

    const rows = await this.prisma.checkIn.findMany({
      where,
      orderBy: [{ timeIn: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        partyId: true,
        customerName: true,
        purpose: true,
        purposeCode: true,
        outcome: true,
        notes: true,
        photoUrl: true,
        metadata: true,
        timeIn: true,
        timeOut: true,
        repName: true,
        store: { select: { id: true, name: true } },
        attendedBy: { select: { id: true, name: true } },
        party: { select: { id: true, code: true } },
        productInteractions: {
          orderBy: { occurredAt: 'asc' },
          select: {
            id: true,
            sku: true,
            kind: true,
            quantity: true,
            notes: true,
            metadata: true,
            product: {
              select: { id: true, name: true, category: true, categoryLabel: true },
            },
          },
        },
      },
    });

    const page = rows.slice(0, limit);

    return {
      date: dateOnly(businessDate(anchor, tz)),
      timezone: tz,
      items: page.map((c) => ({
        id: c.id,
        partyId: c.partyId,
        customerName: c.customerName,
        customerId: c.party?.code ?? null,
        store: c.store,
        timeIn: c.timeIn,
        /** Store-local wall clock, so the counter reads its own time. */
        timeInLocal: formatHHMMInTz(c.timeIn, tz),
        timeOut: c.timeOut,
        timeOutLocal: formatHHMMInTz(c.timeOut, tz),
        durationMin: c.timeOut
          ? Math.round((c.timeOut.getTime() - c.timeIn.getTime()) / 60000)
          : null,
        /*
         * Who attended, as an id where one was recorded. `repName` is a display
         * string from before `attendedById` existed and is offered only as a
         * fallback with a null id — a name is not an identity, and this says
         * which of the two it holds rather than dressing one up as the other.
         */
        attendedBy: c.attendedBy ?? (c.repName ? { id: null, name: c.repName } : null),
        /** The tenant's own purpose code where set; the legacy enum otherwise. */
        purpose: c.purposeCode ?? c.purpose ?? null,
        /*
         * Tenant-defined visit fields exactly as recorded — a jeweller's counter
         * and occasion, a clinic's department. Not renamed or filtered here:
         * this file has no business deciding which of a tenant's own fields
         * matter, and inventing labels for them would be inventing vocabulary.
         */
        fields: (c.metadata ?? null) as Prisma.JsonValue,
        outcome: c.outcome,
        status: visitStatus(c.outcome),
        notes: c.notes,
        /*
         * Where to ASK for the counter photo, not where it is stored.
         *
         * The object's own URL is served by a public-read bucket or by express
         * static, which runs ahead of every guard in this application — so
         * returning it would make a photograph of a customer readable by anyone
         * who ever saw the link. This route checks the caller first.
         */
        photoUrl: c.photoUrl ? `/instore/visits/${c.id}/photo` : null,
        enquiries: c.productInteractions.map((p) => ({
          id: p.id,
          /** The catalogue name where the code matched, the raw code where it did not. */
          name: p.product?.name ?? p.sku ?? null,
          productId: p.product?.id ?? null,
          /*
           * The tenant's own word first.
           *
           * `category` is the jewellery enum (necklace, ring, bangle…) that the
           * original pack shipped with; `categoryLabel` is the neutral ERP
           * field every other industry writes. Preferring the enum would print
           * "ring" on a clinic's floor app.
           */
          category: p.product?.categoryLabel ?? p.product?.category ?? null,
          sku: p.sku,
          converted: p.kind === 'purchased',
          quantity: p.quantity,
          notes: p.notes,
          dropOffReason: readDropOffReason(p.metadata),
        })),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  // ========================================================= today's figures

  /**
   * The branch's day, as aggregates.
   *
   * Every figure is its own `count` against the database. None is derived from
   * the visit list above: that list is one page, and a total taken from a page
   * is wrong the moment there is a second one — which on a busy Saturday is by
   * mid-morning.
   *
   * Where a figure cannot be produced it is `null`, never `0`. "Nobody looked at
   * anything today" and "we do not record what people looked at" are different
   * statements, and a zero tells the manager the first when the truth is the
   * second.
   */
  async today(user: AuthUser, opts: { storeId?: string; date?: string } = {}) {
    const tz = await this.scope.resolveTimezone(user, opts.storeId);
    const anchor = opts.date ? new Date(`${opts.date}T12:00:00Z`) : new Date();
    if (Number.isNaN(anchor.getTime())) {
      throw new BadRequestException('That is not a date this can read.');
    }
    const dayStart = startOfDayInTz(anchor, tz);
    const dayEnd = startOfDayAgoInTz(anchor, tz, -1);
    const storeIds = this.scope.effectiveStoreIds(user, opts.storeId);
    const date = dateOnly(businessDate(anchor, tz));

    // A user with no branch assigned has no branch figures. Returning zeroes
    // without this would run every aggregate against `storeId: { in: [] }`,
    // which is the same answer at four times the cost.
    if (!storeIds.length) {
      return {
        date,
        timezone: tz,
        storeIds,
        footfall: 0,
        converted: 0,
        walkOuts: 0,
        stillIn: 0,
        dropOffRate: null,
        openEnquiries: 0,
        newLeads: 0,
        myVisits: 0,
        topCategories: null,
      };
    }

    const org = { organisationId: user.organisationId };
    const day = { storeId: { in: storeIds }, timeIn: { gte: dayStart, lt: dayEnd } };

    const [footfall, converted, walkOuts, stillIn, openEnquiries, newLeads, myVisits, interest] =
      await Promise.all([
        this.prisma.checkIn.count({ where: { ...org, ...day } }),
        this.prisma.checkIn.count({ where: { ...org, ...day, outcome: 'sale_closed' } }),
        this.prisma.checkIn.count({ where: { ...org, ...day, outcome: 'left' } }),
        this.prisma.checkIn.count({ where: { ...org, ...day, outcome: 'in_store' } }),
        // Deliberately not a "today" figure: an enquiry opened last week and
        // still open is exactly the work the floor is meant to see this morning.
        this.prisma.lead.count({
          where: { ...org, storeId: { in: storeIds }, outcome: 'open' },
        }),
        this.prisma.lead.count({
          where: { ...org, storeId: { in: storeIds }, createdAt: { gte: dayStart, lt: dayEnd } },
        }),
        this.prisma.checkIn.count({ where: { ...org, ...day, attendedById: user.id } }),
        this.prisma.productInteraction.groupBy({
          by: ['productId'],
          where: {
            ...org,
            storeId: { in: storeIds },
            occurredAt: { gte: dayStart, lt: dayEnd },
            productId: { not: null },
          },
          _count: { _all: true },
          orderBy: { _count: { productId: 'desc' } },
          take: 25,
        }),
      ]);

    return {
      date,
      timezone: tz,
      storeIds,
      footfall,
      converted,
      walkOuts,
      stillIn,
      /** Null rather than 0% when nobody came in — there is no rate of nothing. */
      dropOffRate: footfall > 0 ? Math.round((walkOuts / footfall) * 1000) / 10 : null,
      openEnquiries,
      newLeads,
      myVisits,
      topCategories: await this.topCategories(user, interest),
    };
  }

  /**
   * What people asked about today, grouped by the catalogue's own category.
   *
   * `null` when nothing was recorded at all, so the screen can say "nothing has
   * been logged" instead of drawing an empty chart, which reads as "nobody was
   * interested in anything".
   */
  private async topCategories(
    user: AuthUser,
    grouped: { productId: string | null; _count: { _all: number } }[],
  ): Promise<{ name: string; count: number }[] | null> {
    const ids = grouped.map((g) => g.productId).filter((id): id is string => Boolean(id));
    if (!ids.length) return null;

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      select: { id: true, category: true, categoryLabel: true },
    });
    // The tenant's own vocabulary where they have set it; the legacy jewellery
    // enum only as a fallback for the pack that still uses it.
    const categoryOf = new Map(
      products.map((p) => [p.id, p.categoryLabel ?? (p.category as string | null)]),
    );

    const totals = new Map<string, number>();
    for (const row of grouped) {
      const category = row.productId ? categoryOf.get(row.productId) : null;
      if (!category) continue;
      totals.set(category, (totals.get(category) ?? 0) + row._count._all);
    }
    if (!totals.size) return null;

    return [...totals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  /**
   * The photo taken when a visit was recorded.
   *
   * Scoped exactly like the visit list it appears in: the caller's own
   * branches, inside their own tenant. A photograph of a customer at a counter
   * is not something to hand out on an unguessable URL.
   */
  async visitPhoto(user: AuthUser, checkInId: string) {
    const visit = await this.prisma.checkIn.findFirst({
      where: {
        id: checkInId,
        organisationId: user.organisationId,
        ...this.scope.storeFilter(user),
      },
      select: { id: true, photoUrl: true },
    });
    if (!visit) throw new NotFoundException('No such visit.');
    if (!visit.photoUrl) throw new NotFoundException('No photo was taken at this visit.');
    // A row pointing outside its own tenant is a bug, and a bug must not become
    // a disclosure.
    if (!StorageService.keyBelongsTo(visit.photoUrl, user.organisationId)) {
      throw new NotFoundException('No photo was taken at this visit.');
    }
    const object = await this.storage.readObject(visit.photoUrl);
    if (!object) throw new NotFoundException('That photo is no longer stored.');
    return object;
  }

  // ================================================================= forms

  /**
   * The capture forms a salesperson may hand to a customer.
   *
   * Read-only, and narrowed to the branches the caller actually works at.
   * Creating a form is a manager's act — it mints a key that lets anonymous
   * callers file leads into a branch — but SHARING an existing form for your own
   * counter is the ordinary floor job this exists for.
   *
   * The submission counts come from `Lead.originKey`, which the public submit
   * writes as `web_form:<formId>:<submissionId>`. That is the only honest link
   * between a lead and the form that produced it: counting by source instead
   * would count every website lead, including ones from forms long deleted.
   */
  async forms(user: AuthUser, opts: { storeId?: string } = {}) {
    const forms = await this.prisma.leadForm.findMany({
      where: {
        organisationId: user.organisationId,
        ...this.scope.storeFilter(user, opts.storeId),
      },
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        publicKey: true,
        name: true,
        defaultInterest: true,
        campaign: true,
        enabled: true,
        createdAt: true,
        store: { select: { id: true, name: true } },
      },
    });
    if (!forms.length) return [];

    return Promise.all(
      forms.map(async (f) => {
        const prefix = `web_form:${f.id}:`;
        const originFilter = {
          organisationId: user.organisationId,
          originKey: { startsWith: prefix },
        };
        const [total, latest] = await Promise.all([
          this.prisma.lead.count({ where: originFilter }),
          this.prisma.lead.findFirst({
            where: originFilter,
            orderBy: { createdAt: 'desc' },
            select: { id: true, ref: true, customerName: true, createdAt: true, stage: true },
          }),
        ]);
        return {
          id: f.id,
          name: f.name,
          store: f.store,
          enabled: f.enabled,
          campaign: f.campaign,
          defaultInterest: f.defaultInterest,
          createdAt: f.createdAt,
          /*
           * The path only. The public origin is the browser's own, and a server
           * that guessed it would print a link to the wrong host on every
           * preview deployment.
           */
          submitPath: `/enquiry/${f.publicKey}`,
          submissions: { total, latest },
        };
      }),
    );
  }
}

