import { GoneException, Injectable, NotFoundException } from '@nestjs/common';

import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';

export type ApprovalReasonCode = 'total_over_threshold' | 'discount_over_cap';

/** One reason a quote needed a decision, with the numbers behind it. */
export interface ApprovalReason {
  code: ApprovalReasonCode;
  message: string;
  total?: number;
  threshold?: number;
  discountPercent?: number;
  cap?: number;
  requiredRole?: string;
}

export interface ApprovalGate {
  /** Does this quote need a decision before it can be shared? Always false. */
  required: boolean;
  /** Is it cleared to go right now? Always true. */
  cleared: boolean;
  reason: string | null;
  reasons: ApprovalReason[];
  /** The content revision this answer is about. */
  revision: number;
}

const APPROVAL_REMOVED =
  'Quote approval has been removed — a quotation once created is created, with no approval from anybody.';

/**
 * Quote approval — REMOVED (client, 13 Oct: "a quotation once created is
 * created — no approval from anybody").
 *
 * Nothing in the quote lifecycle calls this service any more: the WhatsApp
 * text, the PDF download and the PDF on WhatsApp go out without asking it.
 * What survives is only an answer for an old screen that still asks, so it
 * does not crash — reads report the feature as off (the gate says "cleared"
 * for every quote), writes say plainly that it is gone (410).
 *
 * The HISTORY is deliberately untouched: past decisions keep their columns on
 * Quote (decidedById, approvedTotal, approvalSnapshot, …) and their audit-log
 * entries (quotes.approved / quotes.rejected), so what was signed off before
 * 13 Oct stays readable.
 */
@Injectable()
export class QuoteApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /** Reads as switched off, whatever an old settings row says. */
  async settingsFor(organisationId: string) {
    return {
      organisationId,
      valueThreshold: null as number | null,
      allowSelfApproval: false,
      updatedById: null as string | null,
    };
  }

  saveSettings(..._ignored: unknown[]): never {
    throw new GoneException(APPROVAL_REMOVED);
  }

  /** Every quote is cleared; only its existence (in this org) is checked. */
  async gate(organisationId: string, quoteId: string): Promise<ApprovalGate> {
    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, organisationId },
      select: { revision: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return { required: false, cleared: true, reason: null, reasons: [], revision: quote.revision };
  }

  /* No assertCleared(): the lifecycle calls nothing here. Creating, editing,
   * downloading, sharing and sending a quote do not consult this service at
   * all, and nothing left in it can refuse them. Re-introducing a check would
   * mean adding a call site, not flipping a flag — which is the point. */

  /** Asking for a decision is gone. Scope is still checked first, so a quote
   *  outside the caller's reach stays a 404 rather than becoming a 410 oracle. */
  async request(user: AuthUser, quoteId: string): Promise<never> {
    await this.mustReach(user, quoteId);
    throw new GoneException(APPROVAL_REMOVED);
  }

  decide(..._ignored: unknown[]): never {
    throw new GoneException(APPROVAL_REMOVED);
  }

  /** Nothing waits on anybody. */
  async pending(): Promise<never[]> {
    return [];
  }

  private async mustReach(user: AuthUser, quoteId: string) {
    const quote = await this.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user),
        ...(isSalesScoped(user) ? { assignedRepId: user.id } : {}),
      },
      select: { id: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return quote;
  }
}
