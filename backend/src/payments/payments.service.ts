import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { paymentModeLabel } from '../common/payment-mode.util';
import { CreatePaymentDto } from './dto/payment.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Shape a Payment row (with party/store/sale included) into a CollectionRow. */
function toRow(p: any) {
  return {
    id: p.id,
    date: p.paidAt.toISOString(),
    customer: p.party?.name ?? 'Walk-in',
    ref: p.reference ?? p.sale?.docNo ?? '—',
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

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    // A small grace window absorbs clock skew between a store tablet and the
    // server without allowing a genuinely post-dated receipt.
    if (paidAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException('A collection cannot be dated in the future');
    }

    if (dto.saleId) {
      const sale = await this.prisma.sale.findUnique({
        where: { id: dto.saleId },
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

    const created = await this.prisma.payment.create({
      data: {
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
        payment.party?.name ?? 'walk-in'
      }`,
      metadata: {
        amount: num(payment.amount),
        mode: payment.mode,
        saleId: dto.saleId ?? null,
        reference: dto.reference ?? null,
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
