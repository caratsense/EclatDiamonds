import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { ActivityService } from '../crm/activity.service';
import { ROLE_RANK } from '../common/role.util';
import { paymentModeLabel } from '../common/payment-mode.util';
import { CreatePaymentDto, ReversePaymentDto } from './dto/payment.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Shape a Payment row (with party/store/sale included) into a CollectionRow. */
function toRow(p: any) {
  return {
    id: p.id,
    date: p.paidAt.toISOString(),
    // The customer is the linked party, else the free-text name captured on the
    // receipt. No fabricated "Walk-in" — a nameless collection is now refused at
    // the edge, so a blank here only ever means a legacy import with neither.
    customer: p.party?.name ?? p.reference ?? '—',
    // Ref is the linked sale's document; the payer's name lives in `customer`.
    ref: p.sale?.docNo ?? '—',
    mode: paymentModeLabel(p.mode),
    amount: num(p.amount),
    storeId: p.storeId,
    storeName: p.store?.name ?? '',
    /// Who took the money. Surfaced on the ledger so a till dispute has a name
    /// against every line rather than an anonymous amount.
    recordedBy: p.recordedByName ?? null,
    recordedById: p.recordedById ?? null,
    reconciled: p.reconciled ?? false,
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /payments — collections ledger from Payment, store-scoped. */
  async list(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.payment.findMany({
      where: this.scope.storeFilter(user, headerStore),
      include: { party: true, store: true, sale: true },
      orderBy: { paidAt: 'desc' },
      take: 200,
    });
    return rows.map(toRow);
  }

  /**
   * POST /payments — record a collection against a store.
   *
   * Hardened over the original, which accepted any amount against any sale from
   * any authenticated user and left no record of who entered it:
   *  - the collection is stamped with the recording user;
   *  - a payment against a sale cannot take the sale past its total;
   *  - a future-dated collection is refused (money cannot arrive tomorrow);
   *  - every entry is written to the audit trail.
   */
  async create(user: AuthUser, dto: CreatePaymentDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    await this.scope.assertTradingStore(dto.storeId);

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    // A small grace window absorbs clock skew between a store tablet and the
    // server without allowing a genuinely post-dated receipt.
    if (paidAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException('A collection cannot be dated in the future');
    }

    // A customer named on a collection must be this organisation's — the id
    // arrives from a client and was written unchecked.
    if (dto.partyId && !(await this.prisma.party.count({ where: { id: dto.partyId, organisationId: user.organisationId } }))) {
      throw new NotFoundException('Customer not found');
    }

    if (dto.saleId) {
      const sale = await this.prisma.sale.findFirst({
        where: { id: dto.saleId, organisationId: user.organisationId },
        select: { id: true, storeId: true, totalAmount: true, docNo: true, isCancelled: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');
      // The sale must belong to the store the payment is being booked against,
      // or a collection could be parked on a branch that never made the sale.
      if (sale.storeId !== dto.storeId) {
        throw new BadRequestException('That sale belongs to a different store');
      }
      if (sale.isCancelled) {
        throw new BadRequestException('Cannot record a collection against a cancelled sale');
      }

      const alreadyPaid = await this.prisma.payment.aggregate({
        where: { saleId: dto.saleId },
        _sum: { amount: true },
      });
      const total = num(sale.totalAmount);
      const outstanding = total - num(alreadyPaid._sum.amount);
      // Rounding tolerance: cash settlements are routinely a rupee off.
      if (total > 0 && dto.amount > outstanding + 1) {
        throw new BadRequestException(
          `That exceeds the balance on ${sale.docNo ?? 'this sale'}: ₹${outstanding.toFixed(
            2,
          )} outstanding, ₹${dto.amount.toFixed(2)} offered`,
        );
      }
    }

    // NO DUPLICATE-REFERENCE GUARD, and this is a correction to an earlier
    // report rather than an omission.
    //
    // Previous reports listed "Payment.reference idempotency" as an outstanding
    // P0. Reading the field's own contract (payment.dto.ts) shows the premise is
    // wrong: `reference` is WHO THE MONEY CAME FROM — a free-text payer name for
    // an unlinked walk-in — not a bank/UTR transaction id. The ledger renders it
    // as the customer name for exactly that reason.
    //
    // A uniqueness or duplicate rule over it would therefore refuse the second
    // genuine cash collection from the same person on the same day, which is
    // ordinary counter behaviour. Idempotency needs a field that actually
    // identifies a transaction; that is recorded as follow-up work rather than
    // bolted onto a column that means something else.

    const created = await this.prisma.payment.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId,
        partyId: dto.partyId,
        saleId: dto.saleId,
        reference: dto.reference,
        mode: dto.mode,
        amount: new Prisma.Decimal(dto.amount),
        paidAt,
        reconciled: false,
        recordedById: user.id,
        recordedByName: user.name,
      },
    });
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: created.id },
      include: { party: true, store: true, sale: true },
    });

    await this.audit.record(user, {
      action: 'payment.record',
      entityType: 'Payment',
      entityId: payment.id,
      storeId: payment.storeId,
      summary: `Recorded ₹${num(payment.amount)} ${paymentModeLabel(payment.mode)} from ${
        payment.party?.name ?? payment.reference
      }`,
      metadata: {
        amount: num(payment.amount),
        mode: payment.mode,
        saleId: dto.saleId ?? null,
        reference: dto.reference ?? null,
      },
    });

    // Phase A6 — the payment also belongs on the customer's timeline. The audit
    // log above answers "who did what"; this answers "what happened to this
    // customer", and they are read by different people for different reasons.
    await this.activity.recordFor(user, {
      type: 'payment.recorded',
      summary: `Received ₹${num(payment.amount)} ${paymentModeLabel(payment.mode)}`,
      partyId: payment.partyId,
      storeId: payment.storeId,
      entityType: 'Payment',
      entityId: payment.id,
      channel: 'store',
      occurredAt: payment.paidAt,
      metadata: { amount: num(payment.amount), mode: payment.mode, saleId: dto.saleId ?? null },
    });

    return toRow(payment);
  }

  /**
   * POST /payments/:id/reverse — reverse a collection (store manager → head office).
   *
   * The original Payment is NEVER edited or deleted (financial immutability); a
   * new entry is written carrying the NEGATIVE amount and linked to the original,
   * so every sum nets to zero. At most one reversal per original (unique link),
   * and a reversal cannot itself be reversed. Audited.
   */
  async reverse(user: AuthUser, id: string, dto: ReversePaymentDto) {
    const original = await this.prisma.payment.findUnique({
      where: { id },
      include: { reversedBy: true },
    });
    if (!original) throw new NotFoundException('Payment not found');
    this.scope.assertStoreAllowed(user, original.storeId);
    // Reversing money out is a management correction — store manager and above.
    if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
      throw new ForbiddenException(
        'Only a store manager or head office can reverse a payment',
      );
    }
    if (original.reversesPaymentId) {
      throw new BadRequestException('A reversal entry cannot itself be reversed');
    }
    if (original.reversedBy) {
      throw new BadRequestException('This payment has already been reversed');
    }
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('A reversal reason is required');

    const created = await this.prisma.payment.create({
      data: {
        organisationId: user.organisationId,
        storeId: original.storeId,
        partyId: original.partyId,
        saleId: original.saleId,
        schemeMemberId: original.schemeMemberId,
        reference: original.reference,
        mode: original.mode,
        amount: new Prisma.Decimal(original.amount).negated(),
        paidAt: new Date(),
        reconciled: false,
        recordedById: user.id,
        recordedByName: user.name,
        reversesPaymentId: original.id,
        reversalReason: reason,
      },
    });
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: created.id },
      include: { party: true, store: true, sale: true },
    });

    await this.audit.record(user, {
      action: 'payment.reverse',
      entityType: 'Payment',
      entityId: payment.id,
      storeId: payment.storeId,
      summary: `Reversed ₹${num(original.amount)} ${paymentModeLabel(
        original.mode,
      )} — ${reason}`,
      metadata: {
        reversesPaymentId: original.id,
        amount: num(payment.amount),
        reason,
      },
    });

    return toRow(payment);
  }

  /**
   * GET /payments/reconciliation — store-reported collections vs bank-statement
   * settlement. Bank-statement rows are seeded LedgerEntry(kind=asset,status='bank')
   * keyed by reference "BANK-<storeId>-<mode>-<yyyy-mm-dd>".
   */
  async reconciliation(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];

    const bankRows = await this.prisma.ledgerEntry.findMany({
      where: { storeId: { in: storeIds }, kind: 'asset', status: 'bank' },
      include: { store: true },
      orderBy: { entryDate: 'desc' },
    });

    return bankRows.map((b) => {
      // narration encodes "<mode>|<storeReported>" so a row needs no extra table.
      const [mode, reportedStr] = (b.narration ?? '|').split('|');
      const storeReported = Number(reportedStr) || 0;
      const bankStatement = num(b.amount);
      let status: 'Matched' | 'Unmatched' | 'Pending';
      if (bankStatement === 0) status = 'Pending';
      else if (Math.abs(bankStatement - storeReported) < 1) status = 'Matched';
      else status = 'Unmatched';
      const row: any = {
        id: b.id,
        date: b.entryDate.toISOString().slice(0, 10),
        mode: paymentModeLabel(mode),
        storeName: b.store?.name ?? '',
        storeReported,
        status,
      };
      if (bankStatement > 0) row.bankStatement = bankStatement;
      return row;
    });
  }
}
