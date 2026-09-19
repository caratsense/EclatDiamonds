import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SetTargetDto, UpdateTargetDto } from './dto/target.dto';

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

  /** GET /targets — targets for a period (default current month), store-scoped. */
  async list(user: AuthUser, period?: string, headerStore?: string) {
    const p = period || currentPeriod();
    const rows = await this.prisma.salesTarget.findMany({
      where: { ...this.scope.storeFilter(user, headerStore), period: p },
      include: { store: { select: { name: true } }, staff: { select: { name: true } } },
      orderBy: [{ storeId: 'asc' }, { staffId: 'asc' }],
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        storeId: r.storeId,
        storeName: r.store?.name ?? '',
        staffId: r.staffId ?? null,
        staffName: r.staff?.name ?? null,
        period: r.period,
        amount: num(r.amount),
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
      this.prisma.salesTarget.findMany({
        where: { storeId: { in: storeIds }, staffId: null, period: p },
        select: { storeId: true, amount: true },
      }),
    ]);
    const targetByStore = new Map(targets.map((t) => [t.storeId, num(t.amount)]));

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
        const target = targetByStore.get(st.id) ?? 0;
        const achieved = num(agg._sum.totalAmount);
        const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
        return { storeId: st.id, storeName: st.name, target, achieved, pct };
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
