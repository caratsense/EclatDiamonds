import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from './activity.service';
import { Customer360Service } from './customer360.service';
import { IdentityService } from './identity.service';
import { StorageService } from '../storage/storage.service';
import { saveCapturedPhoto } from '../storage/capture-photo';

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
        leads: {
          where: { closedAt: null },
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
    for (const e of enquiries) {
      if (e.productId) {
        const owned = await this.prisma.product.count({
          where: { id: e.productId, organisationId: user.organisationId },
        });
        if (!owned) throw new BadRequestException('One of the items does not belong to this tenant.');
      }
    }

    const attendedBy = input.attendedByUserId ?? user.id;
    if (input.attendedByUserId) {
      const staff = await this.prisma.user.count({
        where: { id: input.attendedByUserId, organisationId: user.organisationId },
      });
      if (!staff) throw new BadRequestException('That staff member is not in this organisation.');
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
}
