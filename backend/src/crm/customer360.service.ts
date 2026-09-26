import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { isSalesScoped, readableParty } from '../common/sales-scope';
import { AuthUser } from '../common/auth-user';
import { ActivityService } from './activity.service';
import { IdentityService } from './identity.service';
import { AttributionService } from './attribution.service';

/**
 * Customer 360 (Phase A3) — everything known about one customer, assembled from
 * the modules that own each part rather than from a duplicated summary table.
 *
 * WHY NO DENORMALISED SUMMARY: a `Party.lifetimeValue` column would be wrong the
 * moment a sale is voided by a path that forgot to update it, and a customer
 * whose displayed total does not match their own invoice list destroys trust in
 * the whole screen. Totals here are computed from the rows, every time.
 *
 * STORE SCOPING: every section is filtered through StoreScopeService, so a
 * salesperson opening a customer sees that customer's history AT THE STORES THEY
 * WORK IN. The customer record itself is organisation-wide, which is correct —
 * they are one person — but their purchases at another branch are not this
 * salesperson's to read.
 */
@Injectable()
export class Customer360Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly activity: ActivityService,
    private readonly identity: IdentityService,
    private readonly attribution: AttributionService,
  ) {}

  /** Find a customer by any known identity — the showroom "who is this?" lookup. */
  async lookup(user: AuthUser, kind: string, value: string) {
    const result = await this.identity.resolve(
      user,
      { kind: kind as never, value },
      { createIfMissing: false },
    );
    if (!result.partyId) {
      return { found: false as const, reason: result.reason ?? 'No customer matched.' };
    }
    const party = await this.prisma.party.findFirst({
      where: { id: result.partyId, ...readableParty(user) },
      select: { id: true, name: true, phone: true, email: true, city: true, createdAt: true },
    });
    /*
     * A number that belongs to a colleague's customer is not a way to read that
     * customer. The salesperson learns the number is known — enough not to open
     * a duplicate record — and nothing else: no name, no contact, no history.
     */
    if (!party) {
      return {
        found: true as const,
        restricted: true as const,
        reason: 'This customer is looked after by a colleague. Ask your manager to assign them to you.',
      };
    }
    return { found: true as const, customer: party };
  }

  /**
   * The full profile. One round of parallel reads — each section is independently
   * bounded, so a customer with 4,000 timeline events does not turn this into a
   * slow query.
   */
  async profile(user: AuthUser, partyId: string) {
    const organisationId = user.organisationId;
    const storeScope = this.scope.storeFilter(user);
    // A salesperson sees a customer they work with, and only their own dealings
    // with them — never a colleague's leads, visits, quotes or bills, nor the
    // customer's payment ledger.
    const mine = isSalesScoped(user);

    const party = await this.prisma.party.findFirst({
      where: { id: partyId, ...readableParty(user) },
      select: {
        id: true,
        name: true,
        legalName: true,
        code: true,
        types: true,
        phone: true,
        whatsapp: true,
        email: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        pincode: true,
        gstin: true,
        birthday: true,
        anniversary: true,
        isBlacklisted: true,
        attributes: true,
        storeId: true,
        legacyId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!party) throw new NotFoundException('Customer not found');

    const [
      contactPoints,
      leads,
      conversations,
      visits,
      interactions,
      quotes,
      sales,
      payments,
      returns,
      followUps,
      openMerges,
    ] = await Promise.all([
      this.identity.contactPointsFor(user, partyId),
      this.prisma.lead.findMany({
        where: { organisationId, partyId, ...storeScope, ...(mine ? { ownerId: user.id } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true, ref: true, stage: true, source: true, value: true, outcome: true,
          interest: true, lastActivity: true, closedAt: true, createdAt: true,
          owner: { select: { id: true, name: true } },
          store: { select: { id: true, name: true } },
        },
      }),
      this.prisma.conversation.findMany({
        // Scoped like the inbox. This read the organisation's every thread with
        // the customer, other branches and the head-office queue included.
        where: {
          organisationId,
          partyId,
          audience: 'customer',
          AND: [user.allStores ? { OR: [storeScope, { storeId: null }] } : storeScope],
          ...(mine ? { assignedUserId: user.id } : {}),
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 20,
        select: {
          id: true, channel: true, status: true, handling: true, subject: true,
          lastMessageAt: true, lastInboundAt: true, handoffReason: true,
          assignedUser: { select: { id: true, name: true } },
        },
      }),
      this.prisma.checkIn.findMany({
        where: {
          organisationId,
          partyId,
          ...storeScope,
          ...(mine ? { OR: [{ repId: user.id }, { attendedById: user.id }] } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true, purpose: true, outcome: true, createdAt: true,
          store: { select: { id: true, name: true } },
        },
      }),
      this.prisma.productInteraction.findMany({
        where: { organisationId, partyId, OR: [storeScope, { storeId: null }] },
        orderBy: { occurredAt: 'desc' },
        take: 50,
        select: {
          id: true, kind: true, sku: true, occurredAt: true, notes: true, channel: true,
          product: { select: { id: true, sku: true, name: true, imageUrl: true } },
          user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.quote.findMany({
        where: { organisationId, partyId, ...storeScope, ...(mine ? { assignedRepId: user.id } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, ref: true, status: true, kind: true, createdAt: true },
      }),
      this.prisma.sale.findMany({
        where: { organisationId, partyId, ...storeScope, ...(mine ? { salesPersonId: user.id } : {}) },
        orderBy: { docDate: 'desc' },
        take: 50,
        select: {
          id: true, docNo: true, docType: true, docDate: true, totalAmount: true,
          store: { select: { id: true, name: true } },
        },
      }),
      this.prisma.payment.findMany({
        // The payment ledger is a manager's; a salesperson gets none of it.
        where: mine ? { id: '__none__' } : { organisationId, partyId, ...storeScope },
        orderBy: { paidAt: 'desc' },
        take: 50,
        select: {
          id: true, mode: true, amount: true, paidAt: true, reference: true,
          reversesPaymentId: true, reversalReason: true,
        },
      }),
      // Returns/exchanges were linked to the customer in the pipeline pass but
      // never read back here, so a customer's own return history was invisible
      // on their profile — the one screen a counter asks about it from.
      this.prisma.returnRecord.findMany({
        where: { organisationId, partyId, ...storeScope, ...(mine ? { raisedById: user.id } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true, ref: true, type: true, status: true, item: true, value: true,
          createdAt: true,
          store: { select: { id: true, name: true } },
        },
      }),
      // Open follow-ups across this customer's leads. Only the outstanding ones:
      // a completed follow-up is already on the timeline, and repeating it here
      // would bury the two that still need doing.
      this.prisma.leadFollowUp.findMany({
        // `storeScope` rather than a hand-rolled storeIds check: it is the one
        // definition of "stores this user may read", and it stays bounded to the
        // organisation even for head office.
        where: {
          done: false,
          lead: { organisationId, partyId, ...(mine ? { ownerId: user.id } : {}) },
          ...storeScope,
        },
        orderBy: { dueDate: 'asc' },
        take: 25,
        select: {
          id: true, seq: true, dueDate: true, note: true,
          lead: { select: { id: true, ref: true, interest: true } },
        },
      }),
      this.prisma.mergeCandidate.count({
        where: {
          organisationId,
          status: 'open',
          OR: [{ primaryPartyId: partyId }, { duplicatePartyId: partyId }],
        },
      }),
    ]);

    const timeline = await this.activity.timelineForParty(user, partyId, { limit: 50 });
    const attribution = await this.attribution.forParty(user, partyId);

    // Totals are computed over the rows the caller may actually see. Stated
    // explicitly in the payload, because a store manager's "lifetime value" and
    // head office's are legitimately different numbers and a bare figure with no
    // scope note would look like a bug to whichever of them saw the smaller one.
    const totalSpend = sales.reduce((sum, s) => sum.plus(s.totalAmount), new Prisma.Decimal(0));
    // A reversal is stored as a second Payment row carrying the NEGATIVE amount
    // (PaymentsService.reverse), so a plain sum already nets them out. Filtering
    // reversals here would double-count the original.
    const totalPaid = payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

    return {
      customer: party,
      identity: {
        contactPoints,
        openMergeReviews: openMerges,
      },
      summary: {
        scope: user.allStores ? 'all_stores' : 'your_stores',
        scopeNote: user.allStores
          ? 'Totals cover every store in the organisation.'
          : 'Totals cover only the stores you are assigned to; this customer may have more history elsewhere.',
        leadCount: leads.length,
        visitCount: visits.length,
        saleCount: sales.length,
        totalSpend: totalSpend.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        firstSeen: party.createdAt,
        lastActivityAt: timeline.events[0]?.occurredAt ?? null,
      },
      leads,
      conversations,
      visits,
      productInteractions: interactions,
      quotes,
      sales,
      payments,
      returns,
      followUps,
      timeline: timeline.events,
      timelineNextCursor: timeline.nextCursor,
      /**
       * Real attribution now (Phase A10). Still explicitly `unattributed` when
       * nothing is known — the point was never to produce a source, it was to
       * stop implying one.
       */
      attribution,
    };
  }

  /**
   * Record that a customer showed interest in a product.
   *
   * Universal on purpose: `kind` covers viewed/shown/shortlisted/tried/quoted/
   * rejected/purchased, and none of those words assume what the product is.
   */
  async recordInteraction(
    user: AuthUser,
    input: {
      kind: string;
      partyId?: string;
      leadId?: string;
      productId?: string;
      sku?: string;
      storeId?: string;
      channel?: string;
      notes?: string;
      quantity?: number;
    },
  ) {
    const organisationId = user.organisationId;

    // Which store did this happen at?
    //
    // `user.storeIds[0]` was WRONG and is deliberately not used: for head office
    // that is an arbitrary store out of dozens, so a product interaction would be
    // filed against a branch the customer never visited — and it would look
    // perfectly plausible in every report afterwards.
    //
    // A single-store user has exactly one answer, so that is safe to infer.
    // Anyone with a wider scope must say which store, or the interaction is
    // recorded organisation-wide with no store at all. An honestly unattributed
    // row beats a confidently wrong one.
    const storeId =
      input.storeId ?? (user.storeIds.length === 1 ? user.storeIds[0] : null);
    if (storeId) {
      this.scope.assertStoreAllowed(user, storeId);
      await this.scope.assertTradingStore(storeId);
    }

    // Every referenced record must belong to the caller's organisation. Checked
    // explicitly rather than trusting the id, since these arrive from a client.
    if (input.partyId) await this.assertOwned('party', input.partyId, organisationId);
    if (input.leadId) await this.assertOwned('lead', input.leadId, organisationId);
    // And, for a salesperson, it must be their own customer and their own lead.
    if (isSalesScoped(user)) {
      if (
        input.partyId &&
        !(await this.prisma.party.count({ where: { id: input.partyId, ...readableParty(user) } }))
      ) {
        throw new NotFoundException('Customer not found');
      }
      if (
        input.leadId &&
        !(await this.prisma.lead.count({ where: { id: input.leadId, organisationId, ownerId: user.id } }))
      ) {
        throw new NotFoundException('Lead not found');
      }
    }
    if (input.productId) await this.assertOwned('product', input.productId, organisationId);

    // Phase A4 — a scanned or typed SKU becomes a real catalogue link when one
    // exists in THIS organisation. Without this, a showroom scan produced a
    // free-text row that never joined the catalogue, so "which pieces get shown
    // but never sold?" stayed unanswerable.
    //
    // Falling back to free text (rather than rejecting) is deliberate: an item
    // that is not in the catalogue yet still happened, and losing that is worse
    // than storing it unlinked.
    let productId = input.productId ?? null;
    let stockContext: { stockItemId: string; status: string } | null = null;
    const sku = input.sku?.trim();
    if (!productId && sku) {
      const product = await this.prisma.product.findFirst({
        where: { organisationId, sku },
        select: { id: true },
      });
      productId = product?.id ?? null;
    }
    if (sku) {
      // Which physical piece, when the tenant tracks individual stock. Scoped to
      // the caller's stores as well as their organisation.
      const stockItem = await this.prisma.stockItem.findFirst({
        where: { organisationId, sku, ...(storeId ? { storeId } : {}) },
        select: { id: true, status: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (stockItem) stockContext = { stockItemId: stockItem.id, status: stockItem.status };
    }

    const interaction = await this.prisma.productInteraction.create({
      data: {
        organisationId,
        storeId,
        partyId: input.partyId ?? null,
        leadId: input.leadId ?? null,
        productId,
        // The SKU is kept even when it resolved, so the interaction still records
        // exactly what was scanned if the catalogue row is later renamed.
        sku: sku ?? null,
        kind: input.kind,
        userId: user.id,
        channel: input.channel ?? 'store',
        quantity: input.quantity ?? null,
        notes: input.notes ?? null,
        metadata: stockContext ?? undefined,
      },
      include: { product: { select: { sku: true, name: true } } },
    });

    const label = interaction.product?.name ?? input.sku ?? 'an item';
    await this.activity.recordFor(user, {
      type: `product.${input.kind}`,
      summary: `${user.name} recorded "${input.kind}" for ${label}`,
      partyId: input.partyId ?? null,
      leadId: input.leadId ?? null,
      storeId,
      entityType: 'ProductInteraction',
      entityId: interaction.id,
      channel: input.channel ?? 'store',
    });

    return interaction;
  }

  /* ------------------------------------------------------ customer notes */

  /**
   * What this business knows about a person, in its own words.
   *
   * Returns notes written ABOUT the customer and notes written on any of their
   * leads, newest first — one list, because "what do we make of her?" is one
   * question, and nobody asking it cares which record a colleague happened to
   * have open when they typed the answer.
   *
   * Reachability is `readableParty`, the same rule the profile uses: a
   * salesperson reads customers they work with, everyone else reads their
   * organisation's.
   */
  async notesFor(user: AuthUser, partyId: string, limit = 50) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, ...readableParty(user) },
      select: { id: true },
    });
    if (!party) throw new NotFoundException('Customer not found');

    const rows = await this.prisma.leadNote.findMany({
      // Either key reaching this customer qualifies. The lead branch is what
      // makes a note left on an opportunity also show up on the person.
      where: { OR: [{ partyId }, { lead: { partyId } }] },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        kind: true,
        text: true,
        createdAt: true,
        authorName: true,
        leadId: true,
      },
    });

    return rows.map((r) => ({
      ...r,
      /** True when this was written against one opportunity, not the person. */
      onLead: r.leadId != null,
    }));
  }

  /**
   * Record what somebody makes of this customer.
   *
   * Deliberately NOT attached to a lead: a view of the person outlives any one
   * opportunity, and what Éclat asked for — what the branch thinks of this
   * customer — is not a fact about a sale that may never happen.
   */
  async addNote(user: AuthUser, partyId: string, input: { text: string; kind: string }) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, ...readableParty(user) },
      select: { id: true, storeId: true },
    });
    if (!party) throw new NotFoundException('Customer not found');

    const note = await this.prisma.leadNote.create({
      data: {
        organisationId: user.organisationId,
        partyId,
        leadId: null,
        authorId: user.id,
        // Denormalised beside authorId, as the lead path already does, so a note
        // still says who wrote it after that person has left the business.
        authorName: user.name,
        kind: input.kind,
        text: input.text.trim(),
      },
    });

    // Best effort, like every other activity write: the note is already saved
    // and a timeline failure must not undo it.
    this.activity
      .recordFor(user, {
        type: 'customer.note',
        summary: `Note added — ${note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text}`,
        partyId,
        storeId: party.storeId ?? undefined,
        entityType: 'LeadNote',
        entityId: note.id,
      })
      .catch(() => undefined);

    return note;
  }

  private async assertOwned(
    model: 'party' | 'lead' | 'product',
    id: string,
    organisationId: string,
  ): Promise<void> {
    const found = await (this.prisma[model] as unknown as {
      findFirst(args: unknown): Promise<{ id: string } | null>;
    }).findFirst({ where: { id, organisationId }, select: { id: true } });
    if (!found) throw new NotFoundException(`${model} not found`);
  }
}
