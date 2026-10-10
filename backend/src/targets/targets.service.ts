import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SetTargetDto, UpdateTargetDto } from './dto/target.dto';
import { resolveEffectiveTargets } from './effective-targets';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Current month as "YYYY-MM" (local). */
function currentPeriod(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

/** [start, end) date range for a "YYYY-MM" period (local, month-aligned). */
function periodRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

@Injectable()
export class TargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /targets — effective targets for a period (default current month),
   * store-scoped. A month with no typed row carries the latest earlier month's
   * target forward (client, 9 Oct); such rows come back with `carriedFrom` set
   * and `id: null` — there is no row for THIS period to patch or delete, and
   * setting one (POST /targets) overrides the carry-forward from that month on.
   */
  async list(user: AuthUser, period?: string, headerStore?: string) {
    const p = period || currentPeriod();
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    const effective = await resolveEffectiveTargets(this.prisma, {
      storeIds,
      periods: [p],
      includeStaff: true,
    });
    effective.sort((a, b) => a.storeId.localeCompare(b.storeId) || (a.staffId ?? '').localeCompare(b.staffId ?? ''));

    // `id: { in: [] }` is a cheap no-match query, so no special-casing for
    // periods with no per-staff rows.
    const staffIds = [...new Set(effective.flatMap((r) => (r.staffId ? [r.staffId] : [])))];
    const [stores, staff] = await Promise.all([
      this.prisma.store.findMany({
        where: { id: { in: [...new Set(effective.map((r) => r.storeId))] } },
        select: { id: true, name: true },
      }),
      this.prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }),
    ]);
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const staffName = new Map(staff.map((s) => [s.id, s.name]));

    return {
      items: effective.map((r) => ({
        id: r.carriedFrom ? null : r.id,
        storeId: r.storeId,
        storeName: storeName.get(r.storeId) ?? '',
        staffId: r.staffId,
        staffName: r.staffId ? (staffName.get(r.staffId) ?? null) : null,
        period: r.period,
        amount: num(r.amount),
        carriedFrom: r.carriedFrom,
      })),
    };
  }

  /** GET /targets/achievement — whole-store target vs actual sales for a period. */
  async achievement(user: AuthUser, period?: string, headerStore?: string) {
    const p = period || currentPeriod();
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return { items: [] };

    const { start, end } = periodRange(p);
    const [stores, targets] = await Promise.all([
      this.prisma.store.findMany({
        where: { id: { in: storeIds }, attendanceOnly: false },
        select: { id: true, name: true },
      }),
      // Carry-forward: a month without a typed row inherits the latest earlier
      // month's whole-store target (flagged via carriedFrom for the UI).
      resolveEffectiveTargets(this.prisma, { storeIds, periods: [p] }),
    ]);
    const targetByStore = new Map(
      targets.map((t) => [t.storeId, { amount: num(t.amount), carriedFrom: t.carriedFrom }]),
    );

    const items = await Promise.all(
      stores.map(async (st) => {
        const agg = await this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: {
            storeId: st.id,
            docType: 'sale',
            isCancelled: false,
            docDate: { gte: start, lt: end },
          },
        });
        const t = targetByStore.get(st.id);
        const target = t?.amount ?? 0;
        const achieved = num(agg._sum.totalAmount);
        const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
        return {
          storeId: st.id,
          storeName: st.name,
          target,
          achieved,
          pct,
          carriedFrom: t?.carriedFrom ?? null,
        };
      }),
    );

    return { items };
  }

  /** POST /targets — upsert on (storeId, staffId, period). staffId null allowed. */
  async set(user: AuthUser, dto: SetTargetDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    await this.scope.assertTradingStore(dto.storeId);
    const staffId = dto.staffId ?? null;

    // A per-staff target must point at a staffer actually assigned to that store.
    if (staffId) {
      const link = await this.prisma.userStore.findFirst({
        where: { userId: staffId, storeId: dto.storeId },
        select: { userId: true },
      });
      if (!link) {
        throw new BadRequestException('Staff is not assigned to this store');
      }
    }

    // Manual upsert: Postgres treats NULL staffId as distinct in the unique index,
    // so resolve the existing row explicitly (staffId IS NULL) before writing.
    const existing = await this.prisma.salesTarget.findFirst({
      where: { storeId: dto.storeId, staffId, period: dto.period },
    });

    const row = existing
      ? await this.prisma.salesTarget.update({
          where: { id: existing.id },
          data: { amount: new Prisma.Decimal(dto.amount), createdById: user.id },
        })
      : await this.prisma.salesTarget.create({
          data: {
            storeId: dto.storeId,
            staffId,
            period: dto.period,
            amount: new Prisma.Decimal(dto.amount),
            createdById: user.id,
          },
        });

    await this.audit.record(user, {
      action: 'target.set',
      entityType: 'SalesTarget',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Set ${dto.period} target for store ${dto.storeId}${
        staffId ? ` (staff ${staffId})` : ''
      }: ₹${dto.amount}`,
      metadata: { period: dto.period, staffId, amount: dto.amount },
    });

    return this.toView(row);
  }

  /** PATCH /targets/:id — update the amount. */
  async update(user: AuthUser, id: string, dto: UpdateTargetDto) {
    const existing = await this.prisma.salesTarget.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Target not found');
    this.scope.assertStoreAllowed(user, existing.storeId);

    const row = await this.prisma.salesTarget.update({
      where: { id },
      data: { amount: new Prisma.Decimal(dto.amount) },
    });
    return this.toView(row);
  }

  /** DELETE /targets/:id. */
  async remove(user: AuthUser, id: string) {
    const existing = await this.prisma.salesTarget.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Target not found');
    this.scope.assertStoreAllowed(user, existing.storeId);
    await this.prisma.salesTarget.delete({ where: { id } });
    return { ok: true };
  }

  private toView(r: any) {
    return {
      id: r.id,
      storeId: r.storeId,
      staffId: r.staffId ?? null,
      period: r.period,
      amount: num(r.amount),
    };
  }
}
