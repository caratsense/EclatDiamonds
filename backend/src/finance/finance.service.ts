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
    // Previous full month, for period-over-period deltas.
    const prevStart = new Date(monthStart);
    prevStart.setMonth(prevStart.getMonth() - 1);

    // Aggregate revenue (sales + income) and expense for one [gte, lt) window.
    const periodTotals = async (gte: Date, lt: Date) => {
      const [salesAgg, incomeAgg, expenseAgg] = await Promise.all([
        this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte, lt } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'income', entryDate: { gte, lt } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'expense', entryDate: { gte, lt } },
        }),
      ]);
      const revenue = num(salesAgg._sum.totalAmount) + num(incomeAgg._sum.amount);
      const expense = num(expenseAgg._sum.amount);
      // No separate COGS is modelled (single `expense` ledger bucket), so gross
      // profit uses total expense as the cost base. Note the caveat for MIS users.
      const grossProfit = revenue - expense;
      return { revenue, expense, grossProfit, ebitda: grossProfit - expense };
    };

    // `now+1ms` so the current, still-open month includes today.
    const cur = await periodTotals(monthStart, new Date(Date.now() + 1));
    const prev = await periodTotals(prevStart, monthStart);

    // Period-over-period % change, one decimal; 0 when there's no prior base.
    const pct = (curVal: number, prevVal: number): number =>
      prevVal === 0 ? 0 : Math.round(((curVal - prevVal) / prevVal) * 1000) / 10;

    const grossMarginPct =
      cur.revenue === 0 ? 0 : Math.round((cur.grossProfit / cur.revenue) * 1000) / 10;

    return [
      { id: 'revenue', label: 'Revenue (MTD)', value: cur.revenue, delta: pct(cur.revenue, prev.revenue) },
      {
        id: 'gross',
        label: 'Gross Margin',
        value: cur.grossProfit,
        delta: pct(cur.grossProfit, prev.grossProfit),
        // grossMargin% = grossProfit / revenue (extra, non-breaking field).
        pct: grossMarginPct,
      },
      {
        id: 'opex',
        label: 'Operating Expense',
        value: cur.expense,
        delta: pct(cur.expense, prev.expense),
        invertDelta: true,
      },
      { id: 'ebitda', label: 'EBITDA', value: cur.ebitda, delta: pct(cur.ebitda, prev.ebitda) },
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
