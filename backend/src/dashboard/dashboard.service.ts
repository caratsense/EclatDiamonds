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
import { NotificationsService } from '../notifications/notifications.service';

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
    private readonly notifications: NotificationsService,
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

    // Party/product counts scoped exactly like the pages the tiles link to, so
    // the dashboard number matches what /customers and /catalogue show.
    const partyScope = this.scope.storeFilter(user, headerStore);
    // Org-bound: a null-store product must still belong to the caller's org, or a
    // company-wide design from another tenant would inflate this Designs count.
    const productScope = {
      organisationId: user.organisationId,
      OR: [{ storeId: { in: storeIds } }, { storeId: null }],
    };

    const [
      salesToday,
      salesYest,
      footfall,
      pending,
      collections,
      mySalesToday,
      customersCount,
      designsCount,
      stockCount,
    ] = await Promise.all([
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
        this.prisma.party.count({ where: { ...partyScope, types: { has: 'customer' } } }),
        this.prisma.product.count({ where: productScope }),
        this.prisma.stockItem.count({ where: storeWhere }),
      ]);

    const sales = num(salesToday._sum.totalAmount);
    const prior = num(salesYest._sum.totalAmount);
    // Day-over-day: today vs the full prior calendar day, in the store's tz.
    // With no sales yesterday there is no meaningful base — emit `null` (no pill)
    // rather than a misleading "+0.0% vs yesterday".
    const salesDelta = prior > 0 ? ((sales - prior) / prior) * 100 : null;

    // `delta: null` means "no period comparison" — the tile then shows no % pill
    // instead of a misleading 0.0%. Only Sales Today has a real day-over-day base.
    const kpis: any[] = [
      {
        id: 'sales',
        label: 'Sales Today',
        value: sales,
        format: 'inr',
        delta: salesDelta == null ? null : round(salesDelta),
      },
      { id: 'footfall', label: 'Footfall', value: footfall, format: 'number', delta: null },
      {
        id: 'pending',
        label: 'Pending Orders',
        value: pending,
        format: 'number',
        delta: null,
      },
    ];

    if (isBroad) {
      kpis.push({
        id: 'collections',
        label: 'Collections Due',
        value: num(collections._sum.amount),
        format: 'inr',
        delta: null,
      });
    } else {
      kpis.push({
        id: 'my-sales',
        label: 'My Sales Today',
        value: num(mySalesToday._sum.totalAmount),
        format: 'inr',
        delta: null,
      });
    }

    // Book-of-business counts — customers, catalogue designs and stock pieces in
    // scope. Static totals (no day-over-day delta), each tile links to its page.
    kpis.push(
      { id: 'customers', label: 'Customers', value: customersCount, format: 'number', delta: null },
      { id: 'designs', label: 'Designs', value: designsCount, format: 'number', delta: null },
      { id: 'stock', label: 'Stock Pieces', value: stockCount, format: 'number', delta: null },
    );
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
          // Label bars by store NAME (unique per store); two stores can share a
          // city, and a blank/code-like city renders oddly. City kept for tooltip.
          store: st.name,
          city: st.city ?? null,
          revenue: num(agg._sum.totalAmount),
          target: targetByStore.get(st.id) ?? 0,
        };
      }),
    );

    return { salesTrend, storeComparison };
  }

  /** GET /dashboard/tasks — store-scoped task list, newest first. */
  async listTasks(
    user: AuthUser,
    headerStore?: string,
    filter: { mine?: boolean; status?: string; priority?: string; partyId?: string; leadId?: string } = {},
  ) {
    // BUG FIXED HERE: this used `storeFilter` alone, which is
    // `{ storeId: { in: [...] } }` — and a global (null-store) task matches no
    // `in` list. Manager-created organisation-wide tasks were therefore written
    // successfully and then never appeared in the list, which read as the save
    // having failed. Global tasks are now included explicitly, bounded by
    // organisation so the widened query cannot cross a tenant.
    const rows = await this.prisma.task.findMany({
      where: {
        organisationId: user.organisationId,
        OR: [this.scope.storeFilter(user, headerStore), { storeId: null }],
        ...(filter.mine ? { assigneeId: user.id } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.priority ? { priority: filter.priority } : {}),
        ...(filter.partyId ? { partyId: filter.partyId } : {}),
        ...(filter.leadId ? { leadId: filter.leadId } : {}),
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        assignedTo: { select: { id: true, name: true } },
        party: { select: { id: true, name: true } },
        lead: { select: { id: true, ref: true } },
      },
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

    // Assignee is mandatory — @IsNotEmpty catches "", this catches whitespace-only.
    const assignee = dto.assignee.trim();
    if (!assignee) throw new BadRequestException('An assignee is required');

    // Prefer a real user id. `assigneeId` is what "my tasks" and reassignment
    // match on; the NAME is still stored alongside it so the row stays readable
    // if that user is later deactivated or renamed.
    let assigneeId: string | null = null;
    let assigneeName = assignee;
    if (dto.assigneeId) {
      const target = await this.prisma.user.findFirst({
        where: { id: dto.assigneeId, organisationId: user.organisationId, isActive: true },
        select: { id: true, name: true },
      });
      // Scoped to the caller's organisation: an id from a request is not proof
      // of anything, and assigning work into another tenant would be a leak of
      // both the task and the fact that the user exists.
      if (!target) throw new BadRequestException('That person is not in your organisation.');
      assigneeId = target.id;
      assigneeName = target.name;
    }

    // Subjects are verified before they are stored — a task pointing at another
    // tenant's customer would expose that customer's name on this screen.
    if (dto.partyId) await this.assertOwnedRecord('party', dto.partyId, user.organisationId);
    if (dto.leadId) await this.assertOwnedRecord('lead', dto.leadId, user.organisationId);

    const task = await this.prisma.task.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId ?? null,
        title: dto.title,
        detail: dto.detail ?? null,
        assignee: assigneeName,
        assigneeId,
        priority: dto.priority ?? 'normal',
        partyId: dto.partyId ?? null,
        leadId: dto.leadId ?? null,
        status: 'open',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        createdById: user.id,
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        party: { select: { id: true, name: true } },
        lead: { select: { id: true, ref: true } },
      },
    });
    return this.toTaskView(task);
  }

  /** PATCH /dashboard/tasks/:id — advance a task's status (open→in_progress→done). */
  async updateTaskStatus(user: AuthUser, id: string, dto: UpdateTaskStatusDto) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    // Org gate first: a null-store (global) task carries no storeId to scope on, so
    // without this any store_manager of any tenant could mutate another org's task.
    if (task.organisationId !== user.organisationId) throw new NotFoundException('Task not found');
    // Same gate as createTask: a pinned store must be in scope; global (null-store)
    // tasks are manager+ only.
    if (task.storeId) {
      this.scope.assertStoreAllowed(user, task.storeId);
    } else if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
      throw new ForbiddenException('Only store managers may change global tasks');
    }

    const updated = await this.prisma.task.update({
      where: { id },
      // `completedAt` is set once and cleared if the task is reopened, so
      // "when was this finished" survives independently of the status column.
      data: {
        status: dto.status,
        completedAt: dto.status === 'done' ? (task.completedAt ?? new Date()) : null,
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        party: { select: { id: true, name: true } },
        lead: { select: { id: true, ref: true } },
      },
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
      /// Display name. Kept for tasks created before assignee ids existed, where
      /// it is the only record of who was meant.
      assignee: t.assignee ?? '',
      /// The stable identity. Null on those historical rows — which is why the
      /// UI must fall back to the name rather than showing them as unassigned.
      assigneeId: t.assigneeId ?? null,
      assignedTo: t.assignedTo ?? null,
      priority: t.priority ?? 'normal',
      status: t.status,
      dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : '',
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      storeId: t.storeId ?? null,
      party: t.party ?? null,
      lead: t.lead ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  /**
   * A task's subject must belong to the caller's organisation.
   *
   * Checked with a scoped read rather than trusting the id: an id that arrived
   * in a request body proves nothing, and a task pointing at another tenant's
   * customer would print that customer's name on this screen.
   */
  private async assertOwnedRecord(
    model: 'party' | 'lead',
    id: string,
    organisationId: string,
  ): Promise<void> {
    const found =
      model === 'party'
        ? await this.prisma.party.findFirst({ where: { id, organisationId }, select: { id: true } })
        : await this.prisma.lead.findFirst({ where: { id, organisationId }, select: { id: true } });
    if (!found) throw new BadRequestException(`That ${model} is not in your organisation.`);
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

  /**
   * GET /dashboard/assignable-users — active staff in the caller's store scope,
   * so a hand-off can be assigned to a real person (any role may assign).
   */
  async assignableUsers(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (!storeIds.length) return [];
    const links = await this.prisma.userStore.findMany({
      where: { storeId: { in: storeIds } },
      select: { userId: true },
    });
    const ids = [...new Set(links.map((l) => l.userId))];
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return users;
  }

  /**
   * POST /dashboard/handoffs — raise a hand-off; defaults to the user's primary
   * store. If a real assignee is picked, they get a dashboard notification and
   * own the "mark done" step.
   */
  async createHandoff(user: AuthUser, dto: CreateHandoffDto) {
    // A hand-off is filed against ONE concrete store. Only auto-use the caller's
    // store when they have exactly one — a multi-store user (or head office) must
    // name the store explicitly, never silently default to their first branch.
    const storeId =
      dto.storeId ?? (user.storeIds.length === 1 ? user.storeIds[0] : undefined);
    if (!storeId) throw new BadRequestException('Select a store to file this hand-off against');
    this.scope.assertStoreAllowed(user, storeId);

    // Resolve the assignee (if one was picked) — the id drives the notification
    // and "assigned to me"; the name is stored for display.
    const assignedToId = dto.assignedToId ?? null;
    let assignedTo = dto.assignedTo?.trim() || null;
    if (assignedToId) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: assignedToId },
        select: { name: true, isActive: true },
      });
      if (!assignee || !assignee.isActive) throw new BadRequestException('Assignee not found');
      assignedTo = assignee.name;
    }

    const row = await this.prisma.handoff.create({
      data: {
        organisationId: user.organisationId,
        storeId,
        fromDept: dto.fromDept,
        toDept: dto.toDept,
        title: dto.title,
        note: dto.note ?? null,
        assignedTo,
        assignedToId,
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

    // The dashboard notification for the person it was passed to.
    if (assignedToId && assignedToId !== user.id) {
      await this.notifications.emit([assignedToId], {
        kind: 'system',
        title: `New hand-off: ${dto.title}`,
        body: `${dto.fromDept} → ${dto.toDept} · from ${user.name}`,
        href: '/dashboards',
        storeId,
        entityType: 'Handoff',
        entityId: row.id,
        actorId: user.id,
        actorName: user.name,
      });
    }
    return this.toHandoffView(row);
  }

  /**
   * PATCH /dashboard/handoffs/:id — advance status. The assignee marks it `done`;
   * the creator then `closed` (approves). Managers may do either (oversight).
   * Each transition notifies the other party.
   */
  async updateHandoffStatus(user: AuthUser, id: string, dto: UpdateHandoffStatusDto) {
    const row = await this.prisma.handoff.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Hand-off not found');
    this.scope.assertStoreAllowed(user, row.storeId);

    const isAssignee = row.assignedToId === user.id;
    const isCreator = row.createdById === user.id;
    const isManager = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;

    if ((dto.status === 'accepted' || dto.status === 'done') && !isAssignee && !isManager) {
      throw new ForbiddenException('Only the assignee can update this hand-off');
    }
    if (dto.status === 'closed' && !isCreator && !isManager) {
      throw new ForbiddenException('Only the person who raised it can approve it');
    }

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

    // Assignee finished → tell the creator to approve.
    if (dto.status === 'done' && row.createdById !== user.id) {
      await this.notifications.emit([row.createdById], {
        kind: 'system',
        title: `Hand-off finished: ${row.title}`,
        body: `${user.name} marked it done — review and close it`,
        href: '/dashboards',
        storeId: row.storeId,
        entityType: 'Handoff',
        entityId: row.id,
        actorId: user.id,
        actorName: user.name,
      });
    }
    // Creator approved → tell the assignee it's closed.
    if (dto.status === 'closed' && row.assignedToId && row.assignedToId !== user.id) {
      await this.notifications.emit([row.assignedToId], {
        kind: 'system',
        title: `Hand-off approved: ${row.title}`,
        body: `${user.name} approved and closed it`,
        href: '/dashboards',
        storeId: row.storeId,
        entityType: 'Handoff',
        entityId: row.id,
        actorId: user.id,
        actorName: user.name,
      });
    }
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
      assignedToId: h.assignedToId ?? null,
      createdById: h.createdById,
      createdBy: h.createdByName,
      createdAt: h.createdAt.toISOString(),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
