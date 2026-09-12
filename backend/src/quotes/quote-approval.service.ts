import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';

/** Roles that may decide. A salesperson may ask; they may not answer. */
const DECIDERS = new Set(['store_manager', 'area_manager', 'head_office']);

export interface ApprovalGate {
  /** Does this quote need a decision before it can be shared? */
  required: boolean;
  /** Is it cleared to go right now? */
  cleared: boolean;
  /** Why not, in words a salesperson can act on. */
  reason: string | null;
}

/**
 * Approval for a quote.
 *
 * Today `share()` guards only that a phone number exists, so any amount can be
 * WhatsApped to a customer by anybody who can open the screen. This adds the
 * decision the meeting asked for, and — importantly — makes it mean something
 * after the fact.
 *
 * The mechanism worth reading is `approvedTotal`. Approving snapshots the amount
 * that was approved; sharing compares the CURRENT total against it and refuses
 * when they differ. Without that, a quote approved at one price could be edited
 * and sent, and the approval would be decoration.
 */
@Injectable()
export class QuoteApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  async settingsFor(organisationId: string) {
    const row = await this.prisma.quoteApprovalSettings.findUnique({
      where: { organisationId },
    });
    return {
      organisationId,
      valueThreshold: row?.valueThreshold != null ? Number(row.valueThreshold) : null,
      allowSelfApproval: row?.allowSelfApproval ?? false,
      updatedById: row?.updatedById ?? null,
    };
  }

  async saveSettings(
    user: AuthUser,
    input: { valueThreshold?: number | null; allowSelfApproval?: boolean },
  ) {
    const data = {
      ...(input.valueThreshold !== undefined
        ? {
            valueThreshold:
              input.valueThreshold === null ? null : new Prisma.Decimal(input.valueThreshold),
          }
        : {}),
      ...(input.allowSelfApproval !== undefined
        ? { allowSelfApproval: input.allowSelfApproval }
        : {}),
      updatedById: user.id,
    };

    const row = await this.prisma.quoteApprovalSettings.upsert({
      where: { organisationId: user.organisationId },
      create: { organisationId: user.organisationId, ...data },
      update: data,
    });

    await this.audit.record(user, {
      action: 'quotes.approval_policy_changed',
      entityType: 'QuoteApprovalSettings',
      entityId: user.organisationId,
      summary:
        row.valueThreshold == null
          ? 'Quote approval turned off'
          : `Quotes at or above ${row.valueThreshold.toString()} now need approval`,
      metadata: {
        valueThreshold: row.valueThreshold?.toString() ?? null,
        allowSelfApproval: row.allowSelfApproval,
      },
    });

    return this.settingsFor(user.organisationId);
  }

  /**
   * May this quote be shared right now?
   *
   * Called by `share()` before anything leaves. Returns rather than throws so the
   * quote screen can show the state without provoking an error.
   */
  async gate(organisationId: string, quoteId: string): Promise<ApprovalGate> {
    const settings = await this.settingsFor(organisationId);
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, organisationId },
      select: { status: true, grandTotal: true, approvedTotal: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');

    if (settings.valueThreshold == null) {
      return { required: false, cleared: true, reason: null };
    }
    const total = Number(quote.grandTotal);
    if (total < settings.valueThreshold) {
      return { required: false, cleared: true, reason: null };
    }

    if (quote.status === 'rejected') {
      return { required: true, cleared: false, reason: 'This quote was rejected.' };
    }
    if (quote.status !== 'approved') {
      return {
        required: true,
        cleared: false,
        reason: 'This quote needs a manager’s approval before it can be sent.',
      };
    }

    /*
     * Approved — but approved for WHAT?
     *
     * Comparing against the snapshot is what stops "approve a small quote, then
     * edit it upward and send". Any change to the amount after approval sends it
     * back for a new decision.
     */
    const approved = quote.approvedTotal == null ? null : Number(quote.approvedTotal);
    if (approved == null || Math.abs(approved - total) > 0.005) {
      return {
        required: true,
        cleared: false,
        reason: 'The amount changed after approval. Ask for approval again.',
      };
    }

    return { required: true, cleared: true, reason: null };
  }

  /** A salesperson asks for a decision. */
  async request(user: AuthUser, quoteId: string) {
    const quote = await this.mustReach(user, quoteId);
    if (quote.status === 'shared' || quote.status === 'accepted') {
      throw new BadRequestException('That quote has already gone to the customer.');
    }

    const row = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: 'pending_approval',
        requestedById: user.id,
        requestedAt: new Date(),
        // A fresh request clears any previous decision, so a rejected quote that
        // has been corrected does not still read as rejected.
        decidedById: null,
        decidedAt: null,
        decisionReason: null,
        approvedTotal: null,
      },
      select: { id: true, ref: true, status: true, grandTotal: true },
    });

    await this.audit.record(user, {
      action: 'quotes.approval_requested',
      entityType: 'Quote',
      entityId: quoteId,
      storeId: quote.storeId,
      summary: `Approval requested for quote ${row.ref}`,
      metadata: { amount: row.grandTotal.toString() },
    });

    return row;
  }

  async decide(
    user: AuthUser,
    quoteId: string,
    approve: boolean,
    reason?: string,
  ) {
    if (!DECIDERS.has(user.role)) {
      throw new ForbiddenException('Only a manager can decide on a quote.');
    }
    const quote = await this.mustReach(user, quoteId);
    if (quote.status !== 'pending_approval') {
      throw new BadRequestException('That quote is not waiting for a decision.');
    }

    const settings = await this.settingsFor(user.organisationId);
    if (!settings.allowSelfApproval && quote.requestedById === user.id) {
      // Separation is the entire point. A tenant may switch it off deliberately;
      // it is not off by accident.
      throw new ForbiddenException('You cannot approve a quote you asked for yourself.');
    }
    if (!approve && !reason?.trim()) {
      throw new BadRequestException('Give a reason when rejecting a quote.');
    }

    const row = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: approve ? 'approved' : 'rejected',
        decidedById: user.id,
        decidedAt: new Date(),
        decisionReason: reason?.trim() || null,
        // The amount frozen at the moment of the decision. Sharing checks it.
        approvedTotal: approve ? quote.grandTotal : null,
      },
      select: { id: true, ref: true, status: true, approvedTotal: true },
    });

    await this.audit.record(user, {
      action: approve ? 'quotes.approved' : 'quotes.rejected',
      entityType: 'Quote',
      entityId: quoteId,
      storeId: quote.storeId,
      summary: `Quote ${row.ref} ${approve ? 'approved' : 'rejected'}`,
      metadata: {
        amount: quote.grandTotal.toString(),
        requestedBy: quote.requestedById,
        reason: reason?.trim() ?? null,
      },
    });

    return row;
  }

  /** Quotes waiting on this manager. */
  async pending(user: AuthUser) {
    const rows = await this.prisma.quote.findMany({
      where: {
        status: 'pending_approval',
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user),
      },
      orderBy: { requestedAt: 'asc' },
      take: 100,
      select: {
        id: true, ref: true, customerName: true, grandTotal: true,
        requestedAt: true, requestedBy: { select: { id: true, name: true } },
        store: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      customerName: r.customerName,
      amount: Number(r.grandTotal),
      requestedAt: r.requestedAt,
      requestedByName: r.requestedBy?.name ?? null,
      requestedById: r.requestedBy?.id ?? null,
      storeName: r.store?.name ?? null,
    }));
  }

  private async mustReach(user: AuthUser, quoteId: string) {
    const quote = await this.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user),
      },
      select: {
        id: true, ref: true, status: true, storeId: true,
        grandTotal: true, requestedById: true,
      },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return quote;
  }
}
