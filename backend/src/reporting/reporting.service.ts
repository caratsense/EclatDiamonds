import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MetalKind, PaymentMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { isValidEmail, normalizeIndianMobile } from '../common/contact.util';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { paymentModeLabel } from '../common/payment-mode.util';
import {
  businessDate,
  dateOnly,
  instantFromLocalTime,
  resolveTz,
  startOfDayAgoInTz,
  startOfDayInTz,
} from '../common/tz.util';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { EmailService } from '../integrations/email.service';
import {
  ComplianceQueryDto,
  CreateDailyReportDto,
  DailyReportQueryDto,
  ReportChannel,
  ReportPeriod,
  SendDailyReportDto,
  SendReportDto,
} from './dto/reporting.dto';

/** A DailyReport with its store relation eagerly loaded (for the composed text). */
type DailyReportWithStore = Prisma.DailyReportGetPayload<{ include: { store: true } }>;

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** MetalKind values that count as gold — everything else (platinum, silver) is excluded from goldGrams. */
const GOLD_METALS: MetalKind[] = [
  'gold_24k',
  'gold_22k',
  'gold_18k',
  'gold_14k',
  'gold_10k',
  'gold_9k',
  'rose_gold_18k',
  'gold_unspecified',
];

/**
 * Partially mask a phone number or email for the audit trail.
 *
 * The trail needs to show WHERE the store's takings went; it does not need to
 * become a searchable copy of everyone's contact details. Enough characters are
 * kept to recognise a recipient you already know, not to reconstruct one.
 */
function maskRecipient(to: string): string {
  const v = (to ?? '').trim();
  if (!v) return '—';
  const at = v.indexOf('@');
  if (at > 0) {
    const name = v.slice(0, at);
    const head = name.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, name.length - 2))}${v.slice(at)}`;
  }
  const digits = v.replace(/\D/g, '');
  if (digits.length < 4) return '*'.repeat(v.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Every report window in this file is anchored to the STORE's day, not the API
 * server's.
 *
 * `new Date().setHours(0,0,0,0)` reads the server's timezone, which is an
 * environment variable rather than a business fact: the same "today's sales"
 * query then covers a different slice of the day depending on where the
 * container runs, and silently changes meaning if that ever gets configured.
 * The store's own `timezone` column is the only defensible anchor, and it is
 * already what attendance uses.
 */

const PERIOD_LABEL: Record<ReportPeriod, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/** Every PaymentMode enum value, so `byMode` always has a stable, complete shape. */
const ALL_MODES = Object.values(PaymentMode) as PaymentMode[];

/**
 * Resolve the anchor day as a store-local calendar date (a UTC-midnight stand-in,
 * matching the `@db.Date` convention). Defaults to today AT THE STORE.
 */
function anchorDay(date: string | undefined, tz: string): Date {
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  }
  return businessDate(new Date(), tz);
}

/**
 * The [from, toExclusive) instant range for the day / ISO-week (Mon–Sun) /
 * calendar-month that CONTAINS the store-local day `base`.
 *
 * `base` is a UTC-midnight stand-in for a local calendar date, so the arithmetic
 * is done on UTC components and only the final boundaries are converted back to
 * real instants in the store's zone. `Date.UTC` normalises out-of-range day
 * arguments, so month and year rollovers need no special case.
 */
function periodRange(
  period: ReportPeriod,
  base: Date,
  tz: string,
): { from: Date; toExclusive: Date; fromDay: Date; toDayInclusive: Date } {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();

  let fromDay: Date;
  let toDayExclusive: Date;
  if (period === 'weekly') {
    const backToMonday = (base.getUTCDay() + 6) % 7; // 0=Sun..6=Sat -> days since Monday
    fromDay = new Date(Date.UTC(y, m, d - backToMonday));
    toDayExclusive = new Date(Date.UTC(y, m, d - backToMonday + 7));
  } else if (period === 'monthly') {
    fromDay = new Date(Date.UTC(y, m, 1));
    toDayExclusive = new Date(Date.UTC(y, m + 1, 1));
  } else {
    fromDay = new Date(Date.UTC(y, m, d));
    toDayExclusive = new Date(Date.UTC(y, m, d + 1));
  }

  const toDayInclusive = new Date(toDayExclusive);
  toDayInclusive.setUTCDate(toDayInclusive.getUTCDate() - 1);

  return {
    from: instantFromLocalTime(fromDay, 0, tz),
    toExclusive: instantFromLocalTime(toDayExclusive, 0, tz),
    fromDay,
    toDayInclusive,
  };
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

/** Ungrouped rupee amount, e.g. ₹55000 (matches the owner's WhatsApp SALES line). */
function rupeeRaw(n: number): string {
  return `₹${Math.round(n)}`;
}

/** DD/MM/YYYY from a @db.Date value (UTC components — no timezone shift). */
function fmtDMY(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${m}/${d.getUTCFullYear()}`;
}

/** YYYY-MM-DD from a @db.Date value (UTC components — no timezone shift). */
function fmtISODateUTC(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
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
    private readonly audit: AuditService,
  ) {}

  /** GET /reporting/dsr — Daily Sales Report, fully derived (not stored), store-scoped. */
  async dsr(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) {
      return { headline: [], paymentSources: [], storeRevenue: [] };
    }
    // "Today" and "yesterday" at the STORE, not at the API server.
    const tz = await this.scope.resolveTimezone(user, headerStore);
    const now = new Date();
    const todayStart = startOfDayInTz(now, tz);
    const yestStart = startOfDayAgoInTz(now, tz, 1);
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
      .map((p) => ({ source: paymentModeLabel(p.mode), amount: num(p._sum.amount) }))
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
            // Only gold pieces count toward goldGrams. SaleLine has no metal of its
            // own, so read it off the physical piece or, failing that, the design.
            where: {
              sale: { storeId: st.id, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } },
              OR: [
                { stockItem: { metal: { in: GOLD_METALS } } },
                { product: { metal: { in: GOLD_METALS } } },
              ],
            },
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

    const tz = await this.scope.resolveTimezone(user, headerStore);
    const since = startOfDayAgoInTz(new Date(), tz, 30);
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
    const tz = await this.scope.resolveTimezone(user, headerStore);
    const { from, toExclusive, fromDay, toDayInclusive } = periodRange(
      period,
      anchorDay(date, tz),
      tz,
    );
    // The labels come from the store-local calendar days, so a report headed
    // "29 Jul" always means the store's 29 Jul — never a UTC-shifted boundary.
    const fromStr = dateOnly(fromDay);
    const toStr = dateOnly(toDayInclusive);

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
        // Cancelled/refunded orders are not booked takings — exclude them from
        // count, advance and estimation.
        where: { ...storeWhere, bookedOn: range, stage: { not: 'cancelled' } },
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
  /**
   * Validate the outbound recipient for the chosen channel and return it in a
   * consistent form. Rejects letters/garbage rather than salvaging digits — a
   * report is about to be delivered to whatever this resolves to.
   */
  private assertRecipient(channel: ReportChannel, to: string): string {
    if (channel === 'whatsapp') {
      const phone = normalizeIndianMobile(to);
      if (!phone) {
        throw new BadRequestException('Enter a valid 10-digit Indian mobile number');
      }
      return phone;
    }
    if (!isValidEmail(to)) {
      throw new BadRequestException('Enter a valid email address');
    }
    return to.trim();
  }

  async send(
    user: AuthUser,
    dto: SendReportDto,
    headerStore?: string,
  ): Promise<{ sent: boolean; channel: ReportChannel; disabled?: boolean; preview: string }> {
    const to = this.assertRecipient(dto.channel, dto.to);
    const summary = await this.summary(user, dto.period, dto.date, headerStore);
    const preview = this.composeReport(summary);

    let sent = false;
    let disabled = false;
    if (dto.channel === 'whatsapp') {
      if (this.whatsapp.enabled) sent = (await this.whatsapp.sendText(to, preview)).delivered;
      else disabled = true;
    } else if (this.email.enabled) {
      const subject = `CaratSense ${PERIOD_LABEL[dto.period]} Report — ${summary.from} to ${summary.to}`;
      sent = (await this.email.send(to, subject, preview)).sent;
    } else {
      disabled = true;
    }

    // Sending the store's takings OUT of the platform is a disclosure, so the
    // recipient goes in the trail. `to` is masked: the log should show that a
    // number was used without becoming a copy of the contact book.
    await this.audit.record(user, {
      action: 'report.send',
      entityType: 'Report',
      entityId: `${dto.period}:${summary.from}..${summary.to}`,
      storeId: headerStore && headerStore !== 'all' ? headerStore : null,
      summary: `Sent ${PERIOD_LABEL[dto.period]} report (${summary.from} → ${summary.to}) via ${dto.channel} to ${maskRecipient(dto.to)}`,
      metadata: {
        channel: dto.channel,
        to: maskRecipient(dto.to),
        period: dto.period,
        storeCount: summary.storeScope.count,
        sent,
        disabled,
      },
    });

    return disabled
      ? { sent: false, channel: dto.channel, disabled: true, preview }
      : { sent, channel: dto.channel, preview };
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
        .map(([mode, amt]) => `${paymentModeLabel(mode)} ${inr(amt)}`)
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

  // ==========================================================================
  // DAILY SALES REPORT (DSR) — the store-close entry a manager types on WhatsApp,
  // stored so it lives on the website. Store-scoped; additive to the derived
  // /reporting/dsr + /reporting/summary aggregates above.
  // ==========================================================================

  /**
   * GET /reporting/compliance — who has and has NOT filed a daily report.
   *
   * The point of this view is the gaps. A list of submitted reports tells head
   * office what came in; it does not tell them the branch that has been silent
   * for three days, which is the thing worth acting on.
   *
   * Each store is evaluated against its OWN calendar: "today" in Surat is not
   * "today" on a server running UTC, and marking a branch delinquent because of
   * a timezone offset would make the whole view untrustworthy.
   */
  async compliance(user: AuthUser, query: ComplianceQueryDto = {}, headerStore?: string) {
    const days = Math.min(Math.max(Number(query.days) || 7, 1), 31);
    const storeIds = this.scope.effectiveStoreIds(user, query.storeId ?? headerStore);

    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds }, isAggregate: false, isActive: true },
      select: { id: true, name: true, timezone: true },
      orderBy: { name: 'asc' },
    });
    if (!stores.length) {
      return { days, from: null, to: null, stores: [], missingToday: 0 };
    }

    // One query for the whole grid; widen the range by a day at each end so a
    // store in any timezone still finds its own dates inside the result.
    const now = new Date();
    const allDates = new Map<string, Date[]>();
    for (const s of stores) {
      const today = businessDate(now, resolveTz(s.timezone));
      const list: Date[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        list.push(d);
      }
      allDates.set(s.id, list);
    }
    const flat = [...allDates.values()].flat();
    const lower = new Date(Math.min(...flat.map((d) => d.getTime())));
    const upper = new Date(Math.max(...flat.map((d) => d.getTime())));

    const reports = await this.prisma.dailyReport.findMany({
      where: { storeId: { in: stores.map((s) => s.id) }, reportDate: { gte: lower, lte: upper } },
      select: { id: true, storeId: true, reportDate: true, source: true, submittedBy: true },
    });
    const byKey = new Map(reports.map((r) => [`${r.storeId}|${fmtISODateUTC(r.reportDate)}`, r]));

    let missingToday = 0;
    const rows = stores.map((s) => {
      const dates = allDates.get(s.id)!;
      const entries = dates.map((d) => {
        const key = fmtISODateUTC(d);
        const hit = byKey.get(`${s.id}|${key}`);
        return {
          date: key,
          submitted: !!hit,
          source: hit?.source ?? null,
          submittedBy: hit?.submittedBy ?? null,
          reportId: hit?.id ?? null,
        };
      });
      const submitted = entries.filter((e) => e.submitted).length;
      const todayEntry = entries[entries.length - 1];
      if (!todayEntry.submitted) missingToday++;
      return {
        storeId: s.id,
        storeName: s.name,
        submitted,
        missing: entries.length - submitted,
        reportedToday: todayEntry.submitted,
        entries,
      };
    });

    return {
      days,
      from: fmtISODateUTC(lower),
      to: fmtISODateUTC(upper),
      missingToday,
      stores: rows,
    };
  }

  /** POST /reporting/daily — capture a store-close DSR. Store-scoped write. */
  async createDaily(user: AuthUser, dto: CreateDailyReportDto) {
    // A DSR belongs to ONE concrete store. An "All Stores" caller (head_office
    // with no store selected) must pick one — never silently fall through to a
    // default store. assertStoreAllowed is a no-op for allStores users, so this
    // is the only thing stopping a filing under 'all'/'' from landing somewhere.
    const storeId = (dto.storeId ?? '').trim();
    if (!storeId || storeId === 'all') {
      throw new BadRequestException('Select a store to file the DSR for');
    }
    this.scope.assertStoreAllowed(user, storeId);

    // Footfall funnel: serious enquiries are a subset of walk-ins, so they can
    // never exceed the total walk-in count (industry-standard retail metric).
    if (
      dto.walkIns != null &&
      dto.seriousEnquiries != null &&
      dto.seriousEnquiries > dto.walkIns
    ) {
      throw new BadRequestException('Serious enquiries cannot exceed walk-ins');
    }

    // A store-close report is a record of a day that has ended; it cannot be for
    // a future day at the store. Back-dating (late entry) stays allowed.
    const tz = await this.scope.resolveTimezone(user, storeId);
    if (dto.reportDate > dateOnly(businessDate(new Date(), tz))) {
      throw new BadRequestException('Report date cannot be in the future');
    }

    const created = await this.prisma.dailyReport.create({
      data: {
        storeId,
        reportDate: new Date(`${dto.reportDate}T00:00:00.000Z`),
        reportTime: dto.reportTime,
        walkIns: dto.walkIns ?? 0,
        seriousEnquiries: dto.seriousEnquiries ?? 0,
        deliveredBilled: new Prisma.Decimal(dto.deliveredBilled ?? 0),
        bookingsNew: new Prisma.Decimal(dto.bookingsNew ?? 0),
        advanceReceived: new Prisma.Decimal(dto.advanceReceived ?? 0),
        cash: new Prisma.Decimal(dto.cash ?? 0),
        card: new Prisma.Decimal(dto.card ?? 0),
        upi: new Prisma.Decimal(dto.upi ?? 0),
        oldGoldWtG: dto.oldGoldWtG == null ? null : new Prisma.Decimal(dto.oldGoldWtG),
        oldGoldValue: dto.oldGoldValue == null ? null : new Prisma.Decimal(dto.oldGoldValue),
        submittedBy: dto.submittedBy,
      },
      include: { store: true },
    });
    return this.toDailyView(created);
  }

  /** GET /reporting/daily?date=&storeId= — store-scoped list, most recent first. */
  async listDaily(user: AuthUser, query: DailyReportQueryDto, headerStore?: string) {
    const where: Prisma.DailyReportWhereInput = this.scope.storeFilter(
      user,
      query.storeId ?? headerStore,
    );
    if (query.date) {
      where.reportDate = new Date(`${query.date}T00:00:00.000Z`);
    }
    const rows = await this.prisma.dailyReport.findMany({
      where,
      include: { store: true },
      orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map((r) => this.toDailyView(r));
  }

  /** GET /reporting/daily/:id — one report, gated to the caller's store scope. */
  async getDaily(user: AuthUser, id: string) {
    const report = await this.loadScopedDaily(user, id);
    return this.toDailyView(report);
  }

  /**
   * POST /reporting/daily/:id/send — compose the exact WhatsApp DSR text and
   * deliver it over WhatsApp or email. Mirrors /reporting/send: each channel
   * degrades to a safe no-op (sent=false, disabled=true) when unconfigured, and
   * the composed preview is always returned.
   */
  async sendDaily(
    user: AuthUser,
    id: string,
    dto: SendDailyReportDto,
  ): Promise<{ sent: boolean; channel: ReportChannel; disabled?: boolean; preview: string }> {
    const to = this.assertRecipient(dto.channel, dto.to);
    const report = await this.loadScopedDaily(user, id);
    const preview = this.composeDsrText(report);

    let sent = false;
    let disabled = false;
    if (dto.channel === 'whatsapp') {
      if (this.whatsapp.enabled) sent = (await this.whatsapp.sendText(to, preview)).delivered;
      else disabled = true;
    } else if (this.email.enabled) {
      const subject = `Daily Sales Report — ${report.store?.name ?? 'Store'} — ${fmtDMY(report.reportDate)}`;
      sent = (await this.email.send(to, subject, preview)).sent;
    } else {
      disabled = true;
    }

    await this.audit.record(user, {
      action: 'report.send_dsr',
      entityType: 'DailyReport',
      entityId: report.id,
      storeId: report.storeId,
      summary: `Sent DSR for ${report.store?.name ?? 'store'} (${fmtDMY(
        report.reportDate,
      )}) via ${dto.channel} to ${maskRecipient(dto.to)}`,
      metadata: { channel: dto.channel, to: maskRecipient(dto.to), sent, disabled },
    });

    return disabled
      ? { sent: false, channel: dto.channel, disabled: true, preview }
      : { sent, channel: dto.channel, preview };
  }

  /** Fetch a DSR by id and assert it is within the caller's store scope. */
  private async loadScopedDaily(user: AuthUser, id: string): Promise<DailyReportWithStore> {
    const report = await this.prisma.dailyReport.findUnique({
      where: { id },
      include: { store: true },
    });
    if (!report) throw new NotFoundException('Daily report not found');
    this.scope.assertStoreAllowed(user, report.storeId);
    return report;
  }

  /**
   * Render a DSR as the EXACT WhatsApp text the owner types at store close.
   * The old-gold line shows `__ gm / ₹__` placeholders when no gold was taken.
   */
  composeDsrText(report: DailyReportWithStore): string {
    const storeName = report.store?.name ?? '—';
    const oldGoldWt = report.oldGoldWtG == null ? '__' : String(Number(report.oldGoldWtG));
    const oldGoldVal = report.oldGoldValue == null ? '₹__' : inr(Number(report.oldGoldValue));

    const header = [`STORE: ${storeName}`, `DATE: ${fmtDMY(report.reportDate)}`];
    if (report.reportTime) header.push(`TIME: ${report.reportTime}`);

    return [
      header.join('   '),
      'TRAFFIC'.padEnd(10) +
        [`Walk-ins: ${report.walkIns}`, `Serious enquiries: ${report.seriousEnquiries}`].join('   '),
      'SALES'.padEnd(10) +
        [
          `Delivered & billed: ${rupeeRaw(num(report.deliveredBilled))}`,
          `Bookings (new): ${rupeeRaw(num(report.bookingsNew))} approx`,
          `Advance received: ${rupeeRaw(num(report.advanceReceived))}`,
        ].join('   '),
      ''.padEnd(10) +
        [
          `→ Cash ${inr(num(report.cash))}`,
          `→ Card ${inr(num(report.card))}`,
          `→ UPI ${inr(num(report.upi))}`,
          `→ Old gold (wt/val): ${oldGoldWt} gm / ${oldGoldVal}`,
        ].join('   '),
      `Submitted by: ${report.submittedBy ?? '—'}`,
    ].join('\n');
  }

  /** Serialise a DSR row for JSON (Decimals → numbers) with a composed `text` preview. */
  private toDailyView(r: DailyReportWithStore) {
    return {
      id: r.id,
      storeId: r.storeId,
      storeName: r.store?.name ?? null,
      reportDate: fmtISODateUTC(r.reportDate),
      reportTime: r.reportTime,
      walkIns: r.walkIns,
      seriousEnquiries: r.seriousEnquiries,
      deliveredBilled: num(r.deliveredBilled),
      bookingsNew: num(r.bookingsNew),
      advanceReceived: num(r.advanceReceived),
      cash: num(r.cash),
      card: num(r.card),
      upi: num(r.upi),
      oldGoldWtG: r.oldGoldWtG == null ? null : Number(r.oldGoldWtG),
      oldGoldValue: r.oldGoldValue == null ? null : Number(r.oldGoldValue),
      submittedBy: r.submittedBy,
      createdAt: r.createdAt.toISOString(),
      text: this.composeDsrText(r),
    };
  }
}
