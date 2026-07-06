import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { CreateLedgerEntryDto } from './dto/finance.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Shape a LedgerEntry row into the frontend `LedgerEntry` (mock/finance.ts). */
function toLedgerView(e: any): any {
  return {
    // Stable, always-unique React key (the DB id); `id` below is the human ref,
    // which can repeat across stores and must NOT be used as a list key.
    key: e.id,
    id: e.reference || e.id,
    date: e.entryDate.toISOString().slice(0, 10),
    account: e.narration ?? e.kind,
    party: e.party?.name ?? '—',
    store: e.store?.city ?? 'HO',
    type: e.kind === 'AP' ? 'AP' : 'AR',
    debit: e.side === 'debit' ? num(e.amount) : 0,
    credit: e.side === 'credit' ? num(e.amount) : 0,
    status: e.status ?? 'open',
  };
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /** GET /finance/ledger — AP/AR general-ledger rows, store-scoped. */
  async ledger(user: AuthUser, headerStore?: string) {
    const where: Prisma.LedgerEntryWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      kind: { in: ['AR', 'AP'] },
    };
    const rows = await this.prisma.ledgerEntry.findMany({
      where,
      include: { party: true, store: true },
      orderBy: { entryDate: 'desc' },
    });
    return rows.map(toLedgerView);
  }

  /** POST /finance/ledger — record a new AP/AR ledger entry against an allowed store. */
  async createEntry(user: AuthUser, dto: CreateLedgerEntryDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const created = await this.prisma.ledgerEntry.create({
      data: {
        storeId: dto.storeId,
        partyId: dto.partyId,
        kind: dto.kind,
        side: dto.side,
        amount: new Prisma.Decimal(dto.amount),
        entryDate: dto.entryDate ? new Date(dto.entryDate) : new Date(),
        narration: dto.narration,
        status: dto.status,
      },
    });
    const entry = await this.prisma.ledgerEntry.findUnique({
      where: { id: created.id },
      include: { party: true, store: true },
    });
    return toLedgerView(entry);
  }

  /** GET /finance/summary — P&L / MIS cards computed from sales + ledger. */
  async summary(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];
    const storeWhere = { storeId: { in: storeIds } };

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [revenueAgg, expenseAgg, incomeAgg] = await Promise.all([
      this.prisma.sale.aggregate({
        _sum: { totalAmount: true },
        where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: monthStart } },
      }),
      this.prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { ...storeWhere, kind: 'expense', entryDate: { gte: monthStart } },
      }),
      this.prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { ...storeWhere, kind: 'income', entryDate: { gte: monthStart } },
      }),
    ]);

    const revenue = num(revenueAgg._sum.totalAmount) + num(incomeAgg._sum.amount);
    const opex = num(expenseAgg._sum.amount);
    // Indicative margin model for MIS view.
    const grossMargin = Math.round(revenue * 0.22);
    const ebitda = grossMargin - opex;

    return [
      { id: 'revenue', label: 'Revenue (MTD)', value: revenue, delta: 9.3 },
      { id: 'gross', label: 'Gross Margin', value: grossMargin, delta: 4.1 },
      { id: 'opex', label: 'Operating Expense', value: opex, delta: 6.8, invertDelta: true },
      { id: 'ebitda', label: 'EBITDA', value: ebitda, delta: 11.5 },
    ];
  }

  /** GET /finance/budget — budget-vs-actual per store (budget from planning ledger rows). */
  async budget(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds } },
      select: { id: true, name: true, city: true },
    });

    return Promise.all(
      stores.map(async (st) => {
        const [actualAgg, budgetRow] = await Promise.all([
          this.prisma.sale.aggregate({
            _sum: { totalAmount: true },
            where: { storeId: st.id, isCancelled: false, docType: 'sale', docDate: { gte: monthStart } },
          }),
          this.prisma.ledgerEntry.findFirst({
            where: { storeId: st.id, kind: 'income', status: 'budget' },
            orderBy: { entryDate: 'desc' },
          }),
        ]);
        return {
          store: st.city,
          budget: num(budgetRow?.amount),
          actual: num(actualAgg._sum.totalAmount),
        };
      }),
    );
  }

  /** GET /finance/cashflow — 6-month inflow vs outflow forecast (from planning rows + sales). */
  async cashflow(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];
    const storeWhere = { storeId: { in: storeIds } };

    const now = new Date();
    const out: any[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const label = MONTHS[d.getMonth()];

      // Inflow: realised sales for current/past months, forecast rows for the future.
      const [salesAgg, forecastAgg, rentAgg, salaryAgg, newStoreAgg] = await Promise.all([
        this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: d, lt: next } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'income', status: 'forecast', entryDate: { gte: d, lt: next } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'expense', narration: 'Rentals', entryDate: { gte: d, lt: next } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'expense', narration: 'Salaries', entryDate: { gte: d, lt: next } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'expense', narration: 'New Store', entryDate: { gte: d, lt: next } },
        }),
      ]);

      out.push({
        month: label,
        inflow: num(salesAgg._sum.totalAmount) + num(forecastAgg._sum.amount),
        rentals: num(rentAgg._sum.amount),
        salaries: num(salaryAgg._sum.amount),
        newStore: num(newStoreAgg._sum.amount),
      });
    }
    return out;
  }
}
