import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { instantFromLocalTime, resolveTz, zonedParts } from '../common/tz.util';
import { UpsertCommissionPlanDto } from './dto/commission-plan.dto';

/**
 * STORE-level sales commission (client call 9 Oct 2026, item 13).
 *
 *   commission = max(0, qualifying monthly sales − threshold) × ratePercent/100
 *
 * Threshold and rate are per-store CONFIGURATION (CommissionPlan, head-office
 * set) — e.g. Bandra ₹15,00,000 at 1%, Kala Ghoda ₹25,00,000 — never constants.
 *
 * Open points the client left, decided here:
 *
 * PERIOD — the CALENDAR MONTH at the STORE's timezone. A month is a business
 * fact at the branch, not at the API server's clock (same rule as every other
 * report window; see common/tz.util.ts). The window is the half-open UTC range
 * [00:00 on the 1st, 00:00 on the next 1st) as observed in Store.timezone.
 *
 * QUALIFYING SALES — the store's non-cancelled `docType='sale'` Sale rows for
 * the window, NET of the store's non-cancelled `docType='sale_return'` rows for
 * the same window (sum of totalAmount each side). Netting rides on the Sale
 * ledger itself rather than on ReturnRecord because:
 *   - legacy JWSR return bills sync in as Sale docType 'sale_return'
 *     (sync.util.docTypeFromTranType), and reporting.service already counts
 *     returns from exactly those rows — one definition of "returns" everywhere;
 *   - ReturnRecord.value is an ESTIMATED / trade-in valuation, and its types
 *     include 'repair' and 'old_gold', which are not revenue reversals;
 *   - a settled ReturnRecord that gets billed also lands as a 'sale_return'
 *     Sale row, so subtracting both would double-count.
 * Consequence (stated in the UI hint too): a return REQUEST that has not been
 * billed as a sale-return document yet does not reduce qualifying sales.
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /** GET /commissions/plans — every configured plan in the organisation (HO). */
  async listPlans(user: AuthUser) {
    const rows = await this.prisma.commissionPlan.findMany({
      where: this.scope.orgFilter(user),
      include: { store: { select: { name: true } } },
      orderBy: { store: { name: 'asc' } },
    });
    return { items: rows.map((r) => this.planView(r, r.store.name)) };
  }

  /** PUT /commissions/plans — upsert a store's plan (HO; one plan per store). */
  async upsertPlan(user: AuthUser, dto: UpsertCommissionPlanDto) {
    // storeIds on the principal is organisation-bounded, so this also rejects a
    // store belonging to another organisation.
    this.scope.assertStoreAllowed(user, dto.storeId);
    await this.scope.assertTradingStore(dto.storeId);

    const data = {
      threshold: new Prisma.Decimal(dto.threshold),
      ratePercent: new Prisma.Decimal(dto.ratePercent),
      isActive: dto.isActive ?? true,
    };
    const row = await this.prisma.commissionPlan.upsert({
      where: { storeId: dto.storeId },
      update: { ...data, updatedById: user.id },
      create: {
        ...data,
        organisationId: user.organisationId,
        storeId: dto.storeId,
        createdById: user.id,
      },
      include: { store: { select: { name: true } } },
    });

    await this.audit.record(user, {
      action: 'commission_plan.set',
      entityType: 'CommissionPlan',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Set commission plan for ${row.store.name}: threshold ₹${dto.threshold}, rate ${dto.ratePercent}%${data.isActive ? '' : ' (inactive)'}`,
      metadata: { threshold: dto.threshold, ratePercent: dto.ratePercent, isActive: data.isActive },
    });

    return this.planView(row, row.store.name);
  }

  /**
   * GET /commissions/summary?month=YYYY-MM — per store in scope: the month's
   * qualifying sales, the plan, and the computed commission with its breakdown.
   */
  async summary(user: AuthUser, month?: string, headerStore?: string) {
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month must be "YYYY-MM"');
    }
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return { items: [] };

    const stores = await this.prisma.store.findMany({
      // Only trading branches carry sales/commission — mirrors targets.achievement.
      where: { id: { in: storeIds }, isAggregate: false, isHolding: false, attendanceOnly: false },
      select: { id: true, name: true, timezone: true },
      orderBy: { name: 'asc' },
    });
    const plans = await this.prisma.commissionPlan.findMany({
      where: { ...this.scope.orgFilter(user), storeId: { in: stores.map((s) => s.id) } },
    });
    const planByStore = new Map(plans.map((p) => [p.storeId, p]));

    const items = await Promise.all(
      stores.map(async (st) => {
        const tz = resolveTz(st.timezone);
        const m = month ?? currentMonthInTz(tz);
        const { start, end } = monthRangeInTz(m, tz);

        const [salesAgg, returnsAgg] = await Promise.all([
          this.prisma.sale.aggregate({
            _sum: { totalAmount: true },
            where: { storeId: st.id, docType: 'sale', isCancelled: false, docDate: { gte: start, lt: end } },
          }),
          this.prisma.sale.aggregate({
            _sum: { totalAmount: true },
            where: { storeId: st.id, docType: 'sale_return', isCancelled: false, docDate: { gte: start, lt: end } },
          }),
        ]);

        const sales = salesAgg._sum.totalAmount ?? new Prisma.Decimal(0);
        const returns = returnsAgg._sum.totalAmount ?? new Prisma.Decimal(0);
        const qualifying = sales.sub(returns);

        const plan = planByStore.get(st.id) ?? null;
        let excess: Prisma.Decimal | null = null;
        let commission: Prisma.Decimal | null = null;
        if (plan && plan.isActive) {
          const over = qualifying.sub(plan.threshold);
          excess = over.gt(0) ? over : new Prisma.Decimal(0);
          // Exact decimal arithmetic end to end; only the final rupee amount is
          // rounded, to 2 dp (paise).
          commission = excess.mul(plan.ratePercent).div(100).toDecimalPlaces(2);
        }

        return {
          storeId: st.id,
          storeName: st.name,
          month: m,
          timezone: tz,
          plan: plan ? this.planView(plan, st.name) : null,
          sales: num(sales),
          returns: num(returns),
          qualifyingSales: num(qualifying),
          excess: excess == null ? null : num(excess),
          commission: commission == null ? null : num(commission),
        };
      }),
    );

    return { items };
  }

  private planView(
    r: { id: string; storeId: string; threshold: Prisma.Decimal; ratePercent: Prisma.Decimal; isActive: boolean },
    storeName: string,
  ) {
    return {
      id: r.id,
      storeId: r.storeId,
      storeName,
      threshold: num(r.threshold),
      ratePercent: num(r.ratePercent),
      isActive: r.isActive,
    };
  }
}

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** The current "YYYY-MM" as observed at the store's timezone. */
function currentMonthInTz(tz: string): string {
  const p = zonedParts(new Date(), tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/**
 * [start, end) UTC instants of the "YYYY-MM" calendar month at the store's
 * timezone. instantFromLocalTime resolves "00:00 local on the 1st" to a real
 * instant, so an IST store's September starts at Aug 31 18:30 UTC.
 */
function monthRangeInTz(month: string, tz: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  return {
    start: instantFromLocalTime(new Date(Date.UTC(y, m - 1, 1)), 0, tz),
    end: instantFromLocalTime(new Date(Date.UTC(y, m, 1)), 0, tz),
  };
}
