import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import {
  businessDate,
  dateOnly,
  formatHHMMInTz,
  startOfDayAgoInTz,
} from '../common/tz.util';
import {
  CreateHandoffDto,
  CreateTaskDto,
  UpdateHandoffStatusDto,
  UpdateTaskStatusDto,
} from './dto/dashboard.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/**
 * Start of the day N days ago, AT THE STORE.
 *
 * The previous version used the API server's timezone, so every "today" figure
 * on the dashboard covered whatever slice of the day the container's clock
 * happened to define. A negative `daysAgo` yields a future boundary (used for
 * "before tomorrow" ranges).
 */
function dayStartInTz(tz: string, daysAgo = 0): Date {
  return startOfDayAgoInTz(new Date(), tz, daysAgo);
}

/** Store-local HH:MM for an agenda timestamp. */
function hhmm(d: Date, tz: string): string {
  return formatHHMMInTz(d, tz) ?? '--:--';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /** GET /dashboard/kpis — role/store-scoped aggregates computed from the DB. */
  async kpis(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];
    const storeWhere = { storeId: { in: storeIds } };
    const tz = await this.scope.resolveTimezone(user, headerStore);
    const todayStart = dayStartInTz(tz, 0);
    const yestStart = dayStartInTz(tz, 1);
    const isBroad = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;

    const [salesToday, salesYest, footfall, pending, collections, mySalesToday] =
      await Promise.all([
        this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: { ...storeWhere, isCancelled: false, docType: 'sale', docDate: { gte: todayStart } },
        }),
        this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: {
            ...storeWhere,
            isCancelled: false,
            docType: 'sale',
            docDate: { gte: yestStart, lt: todayStart },
          },
        }),
        this.prisma.checkIn.count({ where: { ...storeWhere, timeIn: { gte: todayStart } } }),
        this.prisma.customOrder.count({
          where: { ...storeWhere, stage: { notIn: ['delivered', 'cancelled'] } },
        }),
        this.prisma.ledgerEntry.aggregate({
          _sum: { amount: true },
          where: { ...storeWhere, kind: 'AR', status: 'open' },
        }),
        this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: {
            ...storeWhere,
            isCancelled: false,
            docType: 'sale',
            salesPersonId: user.id,
            docDate: { gte: todayStart },
          },
        }),
      ]);

    const sales = num(salesToday._sum.totalAmount);
    const prior = num(salesYest._sum.totalAmount);
    const salesDelta = prior > 0 ? ((sales - prior) / prior) * 100 : 0;

    const kpis: any[] = [
      { id: 'sales', label: 'Sales Today', value: sales, format: 'inr', delta: round(salesDelta) },
      { id: 'footfall', label: 'Footfall', value: footfall, format: 'number', delta: 0 },
      {
        id: 'pending',
        label: 'Pending Orders',
        value: pending,
        format: 'number',
        delta: 0,
        invertDelta: true,
      },
    ];

    if (isBroad) {
      kpis.push({
        id: 'collections',
        label: 'Collections Due',
        value: num(collections._sum.amount),
        format: 'inr',
        delta: 0,
        invertDelta: true,
      });
    } else {
      kpis.push({
        id: 'my-sales',
        label: 'My Sales Today',
        value: num(mySalesToday._sum.totalAmount),
        format: 'inr',
        delta: 0,
      });
    }
    return kpis;
  }

  /** GET /dashboard/charts — sales trend + store comparison, store-scoped. */
  async charts(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return { salesTrend: [], storeComparison: [] };

    const tz = await this.scope.resolveTimezone(user, headerStore);
    const storeWhere = { storeId: { in: storeIds }, isCancelled: false, docType: 'sale' as const };

    // ── Monthly sales trend, last 12 months ──────────────────────────────────
    // A 7-day window is empty until the shop bills today, which made the whole
    // chart read as broken on a deployment fed by historical data. A 12-month
    // trend surfaces the real sales history AND the current month.
    const todayYmd = dateOnly(businessDate(dayStartInTz(tz, 0), tz)); // store-local YYYY-MM-DD
    const [ty, tm, td] = todayYmd.split('-').map(Number);
    const months: { key: string; label: string }[] = [];
    for (let i = 11; i >= 0; i--) {
      let y = ty;
      let m = tm - i;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      const key = `${y}-${String(m).padStart(2, '0')}`;
      // Show the year on January and on the first bucket so the axis reads clearly.
      const label = MONTHS[m - 1] + (m === 1 || i === 11 ? ` '${String(y).slice(2)}` : '');
      months.push({ key, label });
    }

    const monthStart = dayStartInTz(tz, td - 1); // store-midnight on the 1st of this month
    const yearAgo = dayStartInTz(tz, 366); // safely covers the 12 buckets

    const [salesRows, monthTargets] = await Promise.all([
      this.prisma.sale.findMany({
        where: { ...storeWhere, docDate: { gte: yearAgo } },
        select: { docDate: true, totalAmount: true },
      }),
      this.prisma.salesTarget.findMany({
        where: { storeId: { in: storeIds }, staffId: null, period: { in: months.map((m) => m.key) } },
        select: { period: true, amount: true },
      }),
    ]);

    const salesByMonth = new Map<string, number>();
    for (const s of salesRows) {
      const key = dateOnly(businessDate(s.docDate, tz)).slice(0, 7); // YYYY-MM
      salesByMonth.set(key, (salesByMonth.get(key) ?? 0) + num(s.totalAmount));
    }
    const targetByMonth = new Map<string, number>();
    for (const t of monthTargets) {
      targetByMonth.set(t.period, (targetByMonth.get(t.period) ?? 0) + num(t.amount));
    }
    const salesTrend = months.map((mo) => ({
      day: mo.label,
      sales: salesByMonth.get(mo.key) ?? 0,
      target: targetByMonth.get(mo.key) ?? 0,
    }));

    // ── This-month revenue by store ──────────────────────────────────────────
    // (today alone is empty until billing; the month is the useful comparison.)
    const currentPeriod = `${ty}-${String(tm).padStart(2, '0')}`;
    const [stores, storeMonthTargets] = await Promise.all([
      this.prisma.store.findMany({
        where: { id: { in: storeIds } },
        select: { id: true, name: true, city: true },
      }),
      this.prisma.salesTarget.findMany({
        where: { storeId: { in: storeIds }, staffId: null, period: currentPeriod },
        select: { storeId: true, amount: true },
      }),
    ]);
    const targetByStore = new Map(storeMonthTargets.map((t) => [t.storeId, num(t.amount)]));
    const storeComparison = await Promise.all(
      stores.map(async (st) => {
        const agg = await this.prisma.sale.aggregate({
          _sum: { totalAmount: true },
          where: { storeId: st.id, isCancelled: false, docType: 'sale', docDate: { gte: monthStart } },
        });
        return {
          store: st.city || st.name,
          revenue: num(agg._sum.totalAmount),
          target: targetByStore.get(st.id) ?? 0,
        };
      }),
    );

    return { salesTrend, storeComparison };
  }

  /** GET /dashboard/tasks — store-scoped task list, newest first. */
  async listTasks(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.task.findMany({
      where: this.scope.storeFilter(user, headerStore),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((t) => this.toTaskView(t));
  }

  /** POST /dashboard/tasks — create a task, optionally pinned to a store. */
  async createTask(user: AuthUser, dto: CreateTaskDto) {
    if (dto.storeId) {
      this.scope.assertStoreAllowed(user, dto.storeId);
    } else if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
      // Global (null-store) tasks are manager+; a salesperson must pin a store.
      throw new BadRequestException('storeId is required');
    }

    const task = await this.prisma.task.create({
      data: {
        storeId: dto.storeId ?? null,
        title: dto.title,
        detail: dto.detail ?? null,
        assignee: dto.assignee ?? null,
        status: 'open',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        createdById: user.id,
      },
    });
    return this.toTaskView(task);
  }

  /** PATCH /dashboard/tasks/:id — advance a task's status (open→in_progress→done). */
  async updateTaskStatus(user: AuthUser, id: string, dto: UpdateTaskStatusDto) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    // Same gate as createTask: a pinned store must be in scope; global (null-store)
    // tasks are manager+ only.
    if (task.storeId) {
      this.scope.assertStoreAllowed(user, task.storeId);
    } else if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
      throw new ForbiddenException('Only store managers may change global tasks');
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: { status: dto.status },
    });
    await this.audit.record(user, {
      action: 'task.status_change',
      entityType: 'Task',
      entityId: id,
      storeId: task.storeId,
      summary: `Task "${task.title}" ${task.status} → ${dto.status}`,
      metadata: { from: task.status, to: dto.status },
    });
    return this.toTaskView(updated);
  }

  private toTaskView(t: any) {
    return {
      id: t.id,
      title: t.title,
      detail: t.detail ?? '',
      assignee: t.assignee ?? '',
      status: t.status,
      dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : '',
      storeId: t.storeId ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  /**
   * GET /dashboard/agenda — TODAY's actionable items derived from real data,
   * store-scoped + role-aware: lead follow-ups due today, open tasks due today,
   * and today's still-open customer check-ins. Lightweight (capped ~20).
   */
  async agenda(user: AuthUser, headerStore?: string) {
    const filter = this.scope.storeFilter(user, headerStore);
    const tz = await this.scope.resolveTimezone(user, headerStore);
    const todayStart = dayStartInTz(tz, 0);
    const tomorrowStart = dayStartInTz(tz, -1);
    const today = { gte: todayStart, lt: tomorrowStart };

    const [followUps, tasks, checkIns] = await Promise.all([
      this.prisma.leadFollowUp.findMany({
        where: { ...filter, done: false, dueDate: today },
        include: { lead: { select: { id: true, customerName: true } } },
        take: 20,
      }),
      this.prisma.task.findMany({
        where: { ...filter, status: { not: 'done' }, dueDate: today },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.checkIn.findMany({
        where: { ...filter, timeIn: today, outcome: { in: ['in_store', 'follow_up'] } },
        orderBy: { timeIn: 'asc' },
        take: 20,
      }),
    ]);

    const items: Array<{
      id: string;
      time?: string;
      title: string;
      type: 'follow_up' | 'task' | 'checkin';
      href: string;
    }> = [];

    for (const f of followUps) {
      items.push({
        id: `followup-${f.id}`,
        title: `Follow up: ${f.lead?.customerName ?? 'lead'}`,
        type: 'follow_up',
        href: `/leads/${f.leadId}`,
      });
    }
    for (const t of tasks) {
      items.push({
        id: `task-${t.id}`,
        title: t.title,
        type: 'task',
        href: '/dashboard',
      });
    }
    for (const c of checkIns) {
      items.push({
        id: `checkin-${c.id}`,
        time: hhmm(c.timeIn, tz),
        title: `Check-in: ${c.customerName}`,
        type: 'checkin',
        href: '/checkins',
      });
    }

    // Timed items first (chronological), then untimed; overall cap ~20.
    items.sort((a, b) => {
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return 0;
    });
    return items.slice(0, 20);
  }

  /** GET /dashboard/handoffs — cross-department hand-offs in scope, newest first. */
  async listHandoffs(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.handoff.findMany({
      where: this.scope.storeFilter(user, headerStore),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((h) => this.toHandoffView(h));
  }

  /** POST /dashboard/handoffs — raise a hand-off; defaults to the user's primary store. */
  async createHandoff(user: AuthUser, dto: CreateHandoffDto) {
    const storeId = dto.storeId ?? user.storeIds[0];
    if (!storeId) throw new BadRequestException('storeId is required');
    this.scope.assertStoreAllowed(user, storeId);

    const row = await this.prisma.handoff.create({
      data: {
        storeId,
        fromDept: dto.fromDept,
        toDept: dto.toDept,
        title: dto.title,
        note: dto.note ?? null,
        assignedTo: dto.assignedTo ?? null,
        createdById: user.id,
        createdByName: user.name,
      },
    });
    await this.audit.record(user, {
      action: 'handoff.create',
      entityType: 'Handoff',
      entityId: row.id,
      storeId,
      summary: `Hand-off ${dto.fromDept} → ${dto.toDept}: ${dto.title}`,
    });
    return this.toHandoffView(row);
  }

  /** PATCH /dashboard/handoffs/:id — advance status (open→accepted→done). */
  async updateHandoffStatus(user: AuthUser, id: string, dto: UpdateHandoffStatusDto) {
    const row = await this.prisma.handoff.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Hand-off not found');
    this.scope.assertStoreAllowed(user, row.storeId);

    const updated = await this.prisma.handoff.update({
      where: { id },
      data: { status: dto.status },
    });
    await this.audit.record(user, {
      action: 'handoff.status_change',
      entityType: 'Handoff',
      entityId: id,
      storeId: row.storeId,
      summary: `Hand-off "${row.title}" ${row.status} → ${dto.status}`,
      metadata: { from: row.status, to: dto.status },
    });
    return this.toHandoffView(updated);
  }

  private toHandoffView(h: any) {
    return {
      id: h.id,
      storeId: h.storeId,
      fromDept: h.fromDept,
      toDept: h.toDept,
      title: h.title,
      note: h.note ?? '',
      status: h.status,
      assignedTo: h.assignedTo ?? '',
      createdBy: h.createdByName,
      createdAt: h.createdAt.toISOString(),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
