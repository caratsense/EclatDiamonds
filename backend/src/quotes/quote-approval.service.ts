import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { assertNotSelfApproval } from '../common/approval.util';
import { ROLE_LABELS, ROLE_RANK } from '../common/role.util';
import { DiscountsService } from '../discounts/discounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';

/** Roles that may decide. A salesperson may ask; they may not answer. */
const DECIDERS = new Set(['store_manager', 'area_manager', 'head_office']);

export type ApprovalReasonCode = 'total_over_threshold' | 'discount_over_cap';

/** One reason a quote needs a decision, with the numbers behind it. */
export interface ApprovalReason {
  code: ApprovalReasonCode;
  /** In words a salesperson can act on. */
  message: string;
  total?: number;
  threshold?: number;
  /** The requested discount, and the cap it went over. */
  discountPercent?: number;
  cap?: number;
  /** The lowest role whose own cap covers the discount. */
  requiredRole?: Role;
}

export interface ApprovalGate {
  /** Does this quote need a decision before it can be shared? */
  required: boolean;
  /** Is it cleared to go right now? */
  cleared: boolean;
  /** Why not, in words a salesperson can act on. */
  reason: string | null;
  /** Every rule that asks for a decision, whether or not it is already met. */
  reasons: ApprovalReason[];
  /** The content revision this answer is about. */
  revision: number;
}

/** What an approval froze. Compared field by field before anything is sent. */
interface ApprovalSnapshot {
  total: number;
  discountPercent: number;
  discountAmount: number;
  revision: number;
  reasons: ApprovalReason[];
}

const QUOTE_SELECT = {
  id: true, ref: true, status: true, storeId: true, requestedById: true,
  grandTotal: true, approvedTotal: true, revision: true, approvedRevision: true,
  approvalSnapshot: true, discountPercent: true, discountAmount: true,
  pricedById: true, pricedByRole: true,
} satisfies Prisma.QuoteSelect;

type GateQuote = Prisma.QuoteGetPayload<{ select: typeof QUOTE_SELECT }>;

/**
 * The columns an edit writes to throw an approval away.
 *
 * Only a quote that was IN the approval flow goes back to draft. A shared or
 * expired quote keeps its status; its new revision is simply not cleared until
 * the gate says so.
 */
export function approvalResetFor(status: string): Prisma.QuoteUpdateInput {
  if (!['pending_approval', 'approved', 'rejected'].includes(status)) return {};
  return {
    status: 'draft',
    requestedAt: null,
    decidedAt: null,
    decisionReason: null,
    approvedTotal: null,
    approvedRevision: null,
    approvalReasons: Prisma.DbNull,
    approvalSnapshot: Prisma.DbNull,
    requestedBy: { disconnect: true },
    decidedBy: { disconnect: true },
  };
}

/**
 * Approval for a quote.
 *
 * Two independent rules can ask for a decision, and either is enough:
 *
 *  - `total_over_threshold` — the tenant's QuoteApprovalSettings.valueThreshold.
 *  - `discount_over_cap` — the quote's discount is above the DiscountLimit cap
 *    (`maxPercent`) for the role of whoever priced it. DiscountLimit is the
 *    single source of truth for discount caps (Module 15); this reads it, it
 *    does not copy it.
 *
 * The mechanism worth reading is the snapshot. Approving freezes the total, the
 * discount and the content revision; sharing compares the CURRENT quote against
 * all three and refuses when any differ. Without that, a quote approved at one
 * price could be edited and sent, and the approval would be decoration.
 */
@Injectable()
export class QuoteApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly discounts: DiscountsService,
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
   * Which rules ask for a decision on this quote as it stands now.
   *
   * Evaluated live rather than stored, so a cap lowered by head office applies
   * to quotes that have not been sent yet.
   */
  private async reasonsFor(organisationId: string, quote: GateQuote): Promise<ApprovalReason[]> {
    const reasons: ApprovalReason[] = [];
    const total = Number(quote.grandTotal);

    const settings = await this.settingsFor(organisationId);
    if (settings.valueThreshold != null && total >= settings.valueThreshold) {
      reasons.push({
        code: 'total_over_threshold',
        message: `The total is at or above ${inr(settings.valueThreshold)}, which needs a manager.`,
        total,
        threshold: settings.valueThreshold,
      });
    }

    const percent = Number(quote.discountPercent);
    if (percent > 0) {
      /*
       * Whose cap: the role that PRICED the quote, frozen when it was priced. A
       * manager's 8% does not become over-cap because a salesperson presses
       * send, and a salesperson's 8% does not become fine because a manager
       * does. An unattributed discount is judged at the lowest rank.
       */
      const role = quote.pricedByRole ?? 'salesperson';
      const verdict = await this.discounts.evaluateOverall(
        organisationId, quote.storeId, role, percent,
      );
      /*
       * A tenant with no DiscountLimit rows has no discount rule to enforce, and
       * this gate stays out of its way — the same "off until configured" stance
       * as the total threshold above. Caps are per tenant and per store, so one
       * tenant's rule never reaches another.
       */
      if (verdict.configured && !verdict.withinOwn) {
        reasons.push({
          code: 'discount_over_cap',
          message: `A ${percent}% discount is over the ${ROLE_LABELS[role]} cap of ${verdict.cap}%. ${ROLE_LABELS[verdict.requiredRole]} approval is needed.`,
          discountPercent: percent,
          cap: verdict.cap,
          requiredRole: verdict.requiredRole,
        });
      }
    }
    return reasons;
  }

  /**
   * May this quote be shared right now?
   *
   * Called by every door out to a customer before anything is composed. Returns
   * rather than throws so the quote screen can show the state without provoking
   * an error.
   */
  async gate(organisationId: string, quoteId: string): Promise<ApprovalGate> {
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, organisationId },
      select: QUOTE_SELECT,
    });
    if (!quote) throw new NotFoundException('Quote not found');

    const reasons = await this.reasonsFor(organisationId, quote);
    const base = { reasons, revision: quote.revision };
    if (!reasons.length) {
      return { required: false, cleared: true, reason: null, ...base };
    }

    if (quote.status === 'rejected') {
      return { required: true, cleared: false, reason: 'This quote was rejected.', ...base };
    }
    if (quote.status !== 'approved') {
      return {
        required: true,
        cleared: false,
        reason: 'This quote needs a manager’s approval before it can be sent.',
        ...base,
      };
    }

    /*
     * Approved — but approved for WHAT?
     *
     * The total, the discount and the revision must all still be what was
     * approved. The total alone is not enough: a bigger discount on a quote
     * whose lines were nudged up can land on the same total while promising
     * the customer something nobody signed off. `approvedRevision` is null only
     * on approvals decided before revisions existed, which are held to their
     * amount as they always were.
     */
    const snapshot = jsonSnapshot(quote.approvalSnapshot);
    const approved = quote.approvedTotal == null ? null : Number(quote.approvedTotal);
    const changed =
      approved == null ||
      Math.abs(approved - Number(quote.grandTotal)) > 0.005 ||
      (quote.approvedRevision != null && quote.approvedRevision !== quote.revision) ||
      (snapshot != null && snapshot.discountPercent !== Number(quote.discountPercent));
    if (changed) {
      return {
        required: true,
        cleared: false,
        reason: 'The quote changed after approval. Ask for approval again.',
        ...base,
      };
    }

    return { required: true, cleared: true, reason: null, ...base };
  }

  /** Throws the gate's own sentence when the quote may not leave. */
  async assertCleared(organisationId: string, quoteId: string): Promise<ApprovalGate> {
    const gate = await this.gate(organisationId, quoteId);
    if (!gate.cleared) {
      throw new ForbiddenException(gate.reason ?? 'This quote cannot be sent yet.');
    }
    return gate;
  }

  /** A salesperson asks for a decision. */
  async request(user: AuthUser, quoteId: string) {
    const quote = await this.mustReach(user, quoteId);
    if (quote.status === 'shared' || quote.status === 'accepted') {
      throw new BadRequestException('That quote has already gone to the customer.');
    }
    // Recorded, so the manager sees why it is on their list and the audit trail
    // says which rule asked.
    const reasons = await this.reasonsFor(user.organisationId, quote);

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
        approvedRevision: null,
        approvalSnapshot: Prisma.DbNull,
        approvalReasons: reasons as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, ref: true, status: true, grandTotal: true, revision: true },
    });

    await this.audit.record(user, {
      action: 'quotes.approval_requested',
      entityType: 'Quote',
      entityId: quoteId,
      storeId: quote.storeId,
      summary: `Approval requested for quote ${row.ref}`,
      metadata: {
        amount: row.grandTotal.toString(),
        revision: row.revision,
        reasons: reasons.map((r) => r.code),
      },
    });

    return { ...row, reasons };
  }

  async decide(
    user: AuthUser,
    quoteId: string,
    approve: boolean,
    reason?: string,
    revision?: number,
  ) {
    if (!DECIDERS.has(user.role)) {
      throw new ForbiddenException('Only a manager can decide on a quote.');
    }
    const quote = await this.mustReach(user, quoteId);
    if (quote.status !== 'pending_approval') {
      throw new BadRequestException('That quote is not waiting for a decision.');
    }
    // The manager decides on what they looked at, not on whatever it has become.
    if (revision != null && revision !== quote.revision) {
      throw new ConflictException('This quote changed since you opened it. Review it again before deciding.');
    }

    const reasons = await this.reasonsFor(user.organisationId, quote);
    const overCap = reasons.find((r) => r.code === 'discount_over_cap');
    if (overCap) {
      /*
       * A discount decision follows Module 15, which has no tenant switch for
       * separation of duties: neither the person who asked nor the person who
       * set the discount may clear it. `allowSelfApproval` is a quote-total
       * setting and deliberately does not reach this far.
       */
      assertNotSelfApproval(user, quote.requestedById, 'quote discount');
      assertNotSelfApproval(user, quote.pricedById, 'quote discount');
      if (approve && overCap.requiredRole && ROLE_RANK[user.role] < ROLE_RANK[overCap.requiredRole]) {
        throw new ForbiddenException(
          `This discount needs ${ROLE_LABELS[overCap.requiredRole]} approval.`,
        );
      }
    } else {
      const settings = await this.settingsFor(user.organisationId);
      if (!settings.allowSelfApproval && quote.requestedById === user.id) {
        // Separation is the entire point. A tenant may switch it off deliberately;
        // it is not off by accident.
        throw new ForbiddenException('You cannot approve a quote you asked for yourself.');
      }
    }
    if (!approve && !reason?.trim()) {
      throw new BadRequestException('Give a reason when rejecting a quote.');
    }

    const snapshot: ApprovalSnapshot | null = approve
      ? {
          total: Number(quote.grandTotal),
          discountPercent: Number(quote.discountPercent),
          discountAmount: Number(quote.discountAmount),
          revision: quote.revision,
          reasons,
        }
      : null;

    // Conditional on the revision read above: an edit that lands between the
    // read and this write must not be approved under the old revision's name.
    const written = await this.prisma.quote.updateMany({
      where: { id: quoteId, status: 'pending_approval', revision: quote.revision },
      data: {
        status: approve ? 'approved' : 'rejected',
        decidedById: user.id,
        decidedAt: new Date(),
        decisionReason: reason?.trim() || null,
        // Frozen at the moment of the decision. Sharing checks all of it.
        approvedTotal: approve ? quote.grandTotal : null,
        approvedRevision: approve ? quote.revision : null,
        approvalSnapshot: snapshot
          ? (snapshot as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });
    if (written.count === 0) {
      throw new ConflictException('This quote changed while you were deciding. Review it again.');
    }
    const row = await this.prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
      select: { id: true, ref: true, status: true, approvedTotal: true, approvedRevision: true },
    });

    await this.audit.record(user, {
      action: approve ? 'quotes.approved' : 'quotes.rejected',
      entityType: 'Quote',
      entityId: quoteId,
      storeId: quote.storeId,
      summary: `Quote ${row.ref} ${approve ? 'approved' : 'rejected'}`,
      metadata: {
        amount: quote.grandTotal.toString(),
        revision: quote.revision,
        discountPercent: Number(quote.discountPercent),
        reasons: reasons.map((r) => r.code),
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
        revision: true, discountPercent: true, discountAmount: true, approvalReasons: true,
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
      revision: r.revision,
      discountPercent: Number(r.discountPercent),
      discountAmount: Number(r.discountAmount),
      reasons: Array.isArray(r.approvalReasons)
        ? (r.approvalReasons as unknown as ApprovalReason[])
        : [],
    }));
  }

  private async mustReach(user: AuthUser, quoteId: string) {
    const quote = await this.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user),
      },
      select: QUOTE_SELECT,
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return quote;
  }
}

function jsonSnapshot(value: Prisma.JsonValue | null): ApprovalSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return typeof raw.discountPercent === 'number' ? (raw as unknown as ApprovalSnapshot) : null;
}

function inr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(amount);
}
