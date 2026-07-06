import { Injectable } from '@nestjs/common';
import { PaymentMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { EmailService } from '../integrations/email.service';
import { ReportChannel, ReportPeriod, SendReportDto } from './dto/reporting.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

function dayStart(daysAgo = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
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

const PERIOD_LABEL: Record<ReportPeriod, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/** Every PaymentMode enum value, so `byMode` always has a stable, complete shape. */
const ALL_MODES = Object.values(PaymentMode) as PaymentMode[];

/** Parse a YYYY-MM-DD anchor into a LOCAL midnight Date (today when omitted). */
function anchorDate(date?: string): Date {
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The [from, toExclusive) range for the day / ISO-week (Mon–Sun) / calendar-month
 * that CONTAINS `base`. All local-time; JS Date normalises out-of-range day args
 * so month/year rollovers are handled automatically.
 */
function periodRange(period: ReportPeriod, base: Date): { from: Date; toExclusive: Date } {
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  if (period === 'weekly') {
    const backToMonday = (base.getDay() + 6) % 7; // 0=Sun..6=Sat -> days since Monday
    return {
      from: new Date(y, m, d - backToMonday),
      toExclusive: new Date(y, m, d - backToMonday + 7),
    };
  }
  if (period === 'monthly') {
    return { from: new Date(y, m, 1), toExclusive: new Date(y, m + 1, 1) };
  }
  return { from: new Date(y, m, d), toExclusive: new Date(y, m, d + 1) };
}

/** Local YYYY-MM-DD (avoids the UTC shift of Date.toISOString). */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format an amount as INR with Indian digit grouping (rounded to the rupee). */
function inr(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  const s = Math.abs(rounded).toString();
  const grouped =
    s.length <= 3
      ? s
      : s.slice(0, -3).replace(/\B(?=(\d\d)+(?!\d))/g, ',') + ',' + s.slice(-3);
  return `${sign}₹${grouped}`;
}

export interface ReportSummary {
  period: ReportPeriod;
  from: string;
  to: string;
  storeScope: { storeIds: string[]; count: number };
  sales: { count: number; gross: number; discount: number; net: number };
  orders: { count: number; advance: number; estimation: number };
  payments: { count: number; total: number; byMode: Record<string, number> };
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly whatsapp: WhatsAppService,
    private readonly email: EmailService,
  ) {}

  /** GET /reporting/dsr — Daily Sales Report, fully derived (not stored), store-scoped. */
  async dsr(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) {
      return { headline: [], paymentSources: [], storeRevenue: [] };
    }
    const todayStart = dayStart(0);
    const yestStart = dayStart(1);
    const storeWhere = { storeId: { in: storeIds } };

    const [
      salesToday,
      salesYest,
      billsToday,
      billsYest,
      walkInsToday,
      walkInsYest,
      paymentsToday,
      stores,
    ] = await Promise.all([
      this.prisma.sale.aggregate({
        _sum: { totalAmount: true },
        where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } },
      }),
      this.prisma.sale.aggregate({
        _sum: { totalAmount: true },
        where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: yestStart, lt: todayStart } },
      }),
      this.prisma.sale.count({
        where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } },
      }),
      this.prisma.sale.count({
        where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: yestStart, lt: todayStart } },
      }),
      this.prisma.checkIn.count({ where: { ...storeWhere, timeIn: { gte: todayStart } } }),
      this.prisma.checkIn.count({ where: { ...storeWhere, timeIn: { gte: yestStart, lt: todayStart } } }),
      this.prisma.payment.groupBy({
        by: ['mode'],
        where: { ...storeWhere, paidAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      this.prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }),
    ]);

    const sales = num(salesToday._sum.totalAmount);
    const priorSales = num(salesYest._sum.totalAmount);
    const atv = billsToday > 0 ? Math.round(sales / billsToday) : 0;
    const priorAtv = billsYest > 0 ? priorSales / billsYest : 0;
    const pct = (cur: number, prior: number) =>
      prior > 0 ? Math.round(((cur - prior) / prior) * 1000) / 10 : 0;

    const headline = [
      { id: 'walkins', label: 'Walk-ins', value: walkInsToday, format: 'number', delta: pct(walkInsToday, walkInsYest) },
      { id: 'bills', label: 'Bills Generated', value: billsToday, format: 'number', delta: pct(billsToday, billsYest) },
      { id: 'sales', label: 'Total Sales', value: sales, format: 'inr', delta: pct(sales, priorSales) },
      { id: 'atv', label: 'Avg. Ticket Value', value: atv, format: 'inr', delta: pct(atv, priorAtv) },
    ];

    const paymentSources = paymentsToday
      .map((p) => ({ source: MODE_LABEL[p.mode] ?? p.mode, amount: num(p._sum.amount) }))
      .filter((p) => p.amount > 0);

    const storeRevenue = await Promise.all(
      stores.map(async (st) => {
        const [rev, bills, walkins, goldLines] = await Promise.all([
          this.prisma.sale.aggregate({
            _sum: { totalAmount: true },
            where: { storeId: st.id, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } },
          }),
          this.prisma.sale.count({
            where: { storeId: st.id, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } },
          }),
          this.prisma.checkIn.count({ where: { storeId: st.id, timeIn: { gte: todayStart } } }),
          this.prisma.saleLine.aggregate({
            _sum: { netWeight: true },
            where: { sale: { storeId: st.id, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } } },
          }),
        ]);
        return {
          store: st.name,
          walkins,
          bills,
          revenue: num(rev._sum.totalAmount),
          goldGrams: Math.round(num(goldLines._sum.netWeight)),
        };
      }),
    );

    return { headline, paymentSources, storeRevenue };
  }

  /** GET /reporting/movers — fast/slow movers by category from sold sale lines + aging stock. */
  async movers(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];

    const since = dayStart(30);
    // Units sold per category in the last 30 days.
    const soldLines = await this.prisma.saleLine.findMany({
      where: {
        sale: { storeId: { in: storeIds }, isCancelled: false, docType: 'sale', docDate: { gte: since } },
      },
      include: { product: true, stockItem: true },
    });

    const unitsByCat = new Map<string, number>();
    for (const l of soldLines) {
      const cat = l.product?.category ?? l.stockItem?.category ?? 'other';
      unitsByCat.set(cat, (unitsByCat.get(cat) ?? 0) + 1);
    }

    // Average age of remaining stock per category (proxy for days-of-stock).
    const stock = await this.prisma.stockItem.findMany({
      where: { storeId: { in: storeIds }, status: { in: ['in_stock', 'aging', 'dead_stock', 'reserved'] } },
      select: { category: true, ageDays: true },
    });
    const ageByCat = new Map<string, { sum: number; n: number }>();
    for (const s of stock) {
      const acc = ageByCat.get(s.category) ?? { sum: 0, n: 0 };
      acc.sum += s.ageDays ?? 0;
      acc.n += 1;
      ageByCat.set(s.category, acc);
    }

    const cats = new Set<string>([...unitsByCat.keys(), ...ageByCat.keys()]);
    const LABEL: Record<string, string> = {
      necklace: 'Necklaces & Sets',
      ring: 'Rings',
      earrings: 'Earrings',
      bangle: 'Bangles & Kadas',
      bracelet: 'Bracelets',
      pendant: 'Pendants',
      chain: 'Chains',
      other: 'Other',
    };

    const rows = [...cats].map((cat) => {
      const units = unitsByCat.get(cat) ?? 0;
      const age = ageByCat.get(cat);
      const daysOfStock = age && age.n > 0 ? Math.round(age.sum / age.n) : 0;
      const trend: 'fast' | 'slow' = daysOfStock > 60 || units <= 1 ? 'slow' : 'fast';
      return {
        category: LABEL[cat] ?? cat,
        unitsSold: units,
        daysOfStock,
        trend,
      };
    });

    return rows.sort((a, b) => b.unitsSold - a.unitsSold);
  }

  /**
   * GET /reporting/summary — daily data rolled up into a daily / weekly / monthly
   * report (Module 10). Store-scoped; every figure is aggregated from real rows,
   * nothing is stored. `date` defaults to today and selects the period that
   * contains it (the day, the ISO week Mon–Sun, or the calendar month).
   */
  async summary(
    user: AuthUser,
    period: ReportPeriod = 'daily',
    date?: string,
    headerStore?: string,
  ): Promise<ReportSummary> {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    const { from, toExclusive } = periodRange(period, anchorDate(date));
    const fromStr = fmtDate(from);
    // Inclusive last day of the window for human-readable output (toExclusive - 1d).
    const toStr = fmtDate(new Date(toExclusive.getTime() - 1));

    const scopeOut = { storeIds, count: storeIds.length };

    if (storeIds.length === 0) {
      return {
        period,
        from: fromStr,
        to: toStr,
        storeScope: scopeOut,
        sales: { count: 0, gross: 0, discount: 0, net: 0 },
        orders: { count: 0, advance: 0, estimation: 0 },
        payments: { count: 0, total: 0, byMode: this.emptyByMode() },
      };
    }

    const storeWhere = { storeId: { in: storeIds } };
    const range = { gte: from, lt: toExclusive };

    const [salesAgg, ordersAgg, paymentsAgg, paymentsByMode] = await Promise.all([
      this.prisma.sale.aggregate({
        _count: true,
        _sum: { grossAmount: true, discountAmount: true, totalAmount: true },
        where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: range },
      }),
      this.prisma.customOrder.aggregate({
        _count: true,
        _sum: { advanceReceived: true, value: true },
        where: { ...storeWhere, bookedOn: range },
      }),
      this.prisma.payment.aggregate({
        _count: true,
        _sum: { amount: true },
        where: { ...storeWhere, paidAt: range },
      }),
      this.prisma.payment.groupBy({
        by: ['mode'],
        _sum: { amount: true },
        where: { ...storeWhere, paidAt: range },
      }),
    ]);

    const byMode = this.emptyByMode();
    for (const row of paymentsByMode) byMode[row.mode] = num(row._sum.amount);

    return {
      period,
      from: fromStr,
      to: toStr,
      storeScope: scopeOut,
      sales: {
        count: salesAgg._count,
        gross: num(salesAgg._sum.grossAmount),
        discount: num(salesAgg._sum.discountAmount),
        net: num(salesAgg._sum.totalAmount),
      },
      orders: {
        count: ordersAgg._count,
        advance: num(ordersAgg._sum.advanceReceived),
        estimation: num(ordersAgg._sum.value),
      },
      payments: {
        count: paymentsAgg._count,
        total: num(paymentsAgg._sum.amount),
        byMode,
      },
    };
  }

  /**
   * POST /reporting/send — compose the same summary as a concise plain-text report
   * and deliver it over WhatsApp or email. Each channel degrades to a safe no-op
   * (sent=false, disabled=true) when its integration is unconfigured — the preview
   * text is always returned so the report can be inspected regardless.
   */
  async send(
    user: AuthUser,
    dto: SendReportDto,
    headerStore?: string,
  ): Promise<{ sent: boolean; channel: ReportChannel; disabled?: boolean; preview: string }> {
    const summary = await this.summary(user, dto.period, dto.date, headerStore);
    const preview = this.composeReport(summary);

    if (dto.channel === 'whatsapp') {
      if (!this.whatsapp.enabled) {
        return { sent: false, channel: 'whatsapp', disabled: true, preview };
      }
      const res = await this.whatsapp.sendText(dto.to, preview);
      return { sent: res.delivered, channel: 'whatsapp', preview };
    }

    // email
    if (!this.email.enabled) {
      return { sent: false, channel: 'email', disabled: true, preview };
    }
    const subject = `CaratSense ${PERIOD_LABEL[dto.period]} Report — ${summary.from} to ${summary.to}`;
    const res = await this.email.send(dto.to, subject, preview);
    return { sent: res.sent, channel: 'email', preview };
  }

  /** All payment modes zero-initialised — keeps the `byMode` shape stable. */
  private emptyByMode(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const mode of ALL_MODES) out[mode] = 0;
    return out;
  }

  /** Render a summary as a concise plain-text report (WhatsApp/email body). */
  private composeReport(s: ReportSummary): string {
    const modeLine =
      Object.entries(s.payments.byMode)
        .filter(([, amt]) => amt > 0)
        .map(([mode, amt]) => `${MODE_LABEL[mode] ?? mode} ${inr(amt)}`)
        .join(' · ') || '—';

    const stores = s.storeScope.count === 1 ? '1 store' : `${s.storeScope.count} stores`;

    return [
      `CaratSense ${PERIOD_LABEL[s.period]} Report`,
      `${s.from} to ${s.to} · ${stores}`,
      '',
      'SALES',
      `  Bills: ${s.sales.count}`,
      `  Gross: ${inr(s.sales.gross)}`,
      `  Discount: ${inr(s.sales.discount)}`,
      `  Net: ${inr(s.sales.net)}`,
      '',
      'ORDERS',
      `  Booked: ${s.orders.count}`,
      `  Advance: ${inr(s.orders.advance)}`,
      `  Estimation: ${inr(s.orders.estimation)}`,
      '',
      'PAYMENTS',
      `  Received: ${s.payments.count}`,
      `  Total: ${inr(s.payments.total)}`,
      `  ${modeLine}`,
    ].join('\n');
  }
}
