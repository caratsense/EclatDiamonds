import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { CreatePaymentDto } from './dto/payment.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

const MODE_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  net_banking: 'Net Banking',
  online: 'Online',
  cheque: 'Cheque',
  gold_exchange: 'Gold Exchange',
};

/** Shape a Payment row (with party/store/sale included) into a CollectionRow. */
function toRow(p: any) {
  return {
    id: p.id,
    date: p.paidAt.toISOString(),
    customer: p.party?.name ?? 'Walk-in',
    ref: p.reference ?? p.sale?.docNo ?? '—',
    mode: MODE_LABEL[p.mode] ?? p.mode,
    amount: num(p.amount),
    storeId: p.storeId,
    storeName: p.store?.name ?? '',
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
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

  /** POST /payments — record a collection against a store. */
  async create(user: AuthUser, dto: CreatePaymentDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const created = await this.prisma.payment.create({
      data: {
        storeId: dto.storeId,
        partyId: dto.partyId,
        saleId: dto.saleId,
        reference: dto.reference,
        mode: dto.mode,
        amount: new Prisma.Decimal(dto.amount),
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
        reconciled: false,
      },
    });
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: created.id },
      include: { party: true, store: true, sale: true },
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
        mode: MODE_LABEL[mode] ?? mode,
        storeName: b.store?.name ?? '',
        storeReported,
        status,
      };
      if (bankStatement > 0) row.bankStatement = bankStatement;
      return row;
    });
  }
}
