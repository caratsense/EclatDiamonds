import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped, readableParty } from '../common/sales-scope';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from './activity.service';
import { businessDate } from '../common/tz.util';

/**
 * The central calling / follow-up workspace.
 *
 * The single most important property here is that the KPI counts are computed
 * with their OWN aggregate queries and never from the page of tasks on screen.
 * A queue screen that derives "overdue" from `rows.filter(...)` reports 50 when
 * the real answer is 94,569, and every decision made from that number is wrong.
 * The tests pin this by creating more rows than one page holds.
 *
 * Nothing here is industry-specific. A task is work owed to a person; a call is
 * a call.
 */

/** How many task rows one page may hold. */
const MAX_PAGE = 100;

/**
 * Who sees a customer's full number.
 *
 * An earlier version of this listed every role, which meant the "masking" did
 * nothing at all — a rule that admits everyone is not a rule. The real one:
 * the agent the task is ASSIGNED to needs to dial it, and a manager oversees the
 * queue. Anyone else browsing a colleague's tasks sees the last four digits —
 * enough to recognise a customer on a list, not enough to lift a contact
 * database off a screen.
 */
const MANAGER_ROLES: Role[] = ['store_manager', 'area_manager', 'head_office'];

function canSeeFullNumber(user: AuthUser, assigneeId: string | null | undefined): boolean {
  return MANAGER_ROLES.includes(user.role) || assigneeId === user.id;
}

function maskNumber(value: string | null | undefined, full: boolean): string | null {
  if (!value) return null;
  if (full) return value;
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * The branch's own calendar day, as the two dates that bound it.
 *
 * `Task.dueDate` is `@db.Date` — a calendar day with no time of day. Comparing
 * it against an instant is what makes a bucket wrong: an instant carries a time,
 * a DATE does not, and the two are reconciled by truncation. Before this was
 * fixed the boundary was IST midnight expressed in UTC (18:30 the previous day),
 * so for part of every evening a task due yesterday compared equal-not-less and
 * fell out of "overdue" into "upcoming" — the one bucket nobody is chasing.
 *
 * Both returned values are midnight UTC, which is exactly how Postgres hands
 * back a DATE, so the comparison is date-to-date with nothing to truncate.
 *
 * The zone comes from the STORE. It used to be the literal -330, with a comment
 * claiming "IST unless the tenant says otherwise" that nothing implemented: a
 * branch outside Asia/Kolkata had its whole queue bucketed at Indian midnight,
 * and a fixed numeric offset would have been wrong across any DST boundary that
 * `tz.util` already handles.
 */
function businessDay(reference: Date, tz: string) {
  const today = businessDate(reference, tz);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  return { today, tomorrow };
}

/**
 * Whole days between a task's due DATE and today's, at the branch.
 *
 * Days, not minutes, because the column holds a date and nothing finer exists to
 * report. The previous `Math.round((Date.now() - dueDate) / 60000)` compared a
 * UTC-midnight DATE against a real instant, so from 05:30 IST every task due
 * TODAY reported as positively overdue and the screen drew a red "3 hr late"
 * badge on rows the KPI card above it was counting, correctly, as not overdue.
 *
 * Positive = overdue by that many days. 0 = due today. Negative = still ahead.
 */
function dueInDays(dueDate: Date | null, today: Date): number | null {
  if (!dueDate) return null;
  return Math.round((today.getTime() - dueDate.getTime()) / DAY_MS);
}

@Injectable()
export class CallingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  // ================================================================== KPIs

  /**
   * Four counts, four aggregates.
   *
   * `_count` on a filtered query is what makes these honest at 100,000 rows.
   * The alternative — fetching and counting in memory — is both slower and
   * silently capped by whatever `take` the list happens to use.
   */
  async summary(
    user: AuthUser,
    opts: { mine?: boolean; storeId?: string; completedWithinDays?: number } = {},
  ) {
    const base = this.taskScope(user, opts);
    const now = new Date();
    const tz = await this.scope.resolveTimezone(user, opts.storeId);
    const { today, tomorrow } = businessDay(now, tz);
    const completedWithin = Math.min(Math.max(opts.completedWithinDays ?? 30, 1), 365);
    const completedSince = new Date(now.getTime() - completedWithin * 24 * 60 * 60_000);

    // Not `as const`: Prisma's filter wants a mutable string[].
    const open: Prisma.TaskWhereInput = { status: { in: ['open', 'in_progress'] } };

    const [overdue, dueToday, upcoming, completed] = await Promise.all([
      this.prisma.task.count({
        where: { ...base, ...open, dueDate: { lt: today } },
      }),
      this.prisma.task.count({
        where: { ...base, ...open, dueDate: { gte: today, lt: tomorrow } },
      }),
      this.prisma.task.count({
        where: { ...base, ...open, dueDate: { gte: tomorrow } },
      }),
      this.prisma.task.count({
        where: { ...base, status: 'done', completedAt: { gte: completedSince } },
      }),
    ]);

    return {
      overdue,
      dueToday,
      upcoming,
      completed,
      completedWithinDays: completedWithin,
      /** So the screen can say which day "today" meant, and where. */
      dayStart: today,
      dayEnd: tomorrow,
      timezone: tz,
    };
  }

  // ================================================================= queue

  async queue(
    user: AuthUser,
    opts: {
      bucket?: 'overdue' | 'today' | 'upcoming' | 'completed';
      mine?: boolean;
      storeId?: string;
      assigneeId?: string;
      priority?: string;
      search?: string;
      limit?: number;
      cursor?: string;
      completedWithinDays?: number;
    } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), MAX_PAGE);
    const base = this.taskScope(user, opts);
    const now = new Date();
    const tz = await this.scope.resolveTimezone(user, opts.storeId);
    const { today, tomorrow } = businessDay(now, tz);
    // The same window the "Completed" KPI counts. They used to disagree: the
    // card counted the last 30 days and this listed every task ever finished,
    // so clicking a card reading 12 produced a list of 900.
    const completedWithin = Math.min(Math.max(opts.completedWithinDays ?? 30, 1), 365);
    const completedSince = new Date(now.getTime() - completedWithin * DAY_MS);

    const bucketWhere: Prisma.TaskWhereInput =
      opts.bucket === 'overdue'
        ? { status: { in: ['open', 'in_progress'] }, dueDate: { lt: today } }
        : opts.bucket === 'today'
          ? { status: { in: ['open', 'in_progress'] }, dueDate: { gte: today, lt: tomorrow } }
          : opts.bucket === 'upcoming'
            ? { status: { in: ['open', 'in_progress'] }, dueDate: { gte: tomorrow } }
            : opts.bucket === 'completed'
              ? { status: 'done', completedAt: { gte: completedSince } }
              : {};

    const search = (opts.search ?? '').trim();
    const searchWhere: Prisma.TaskWhereInput = search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { party: { name: { contains: search, mode: 'insensitive' } } },
            { lead: { ref: { contains: search, mode: 'insensitive' } } },
            // A number fragment finds the customer it belongs to. Same rule as
            // the floor app: the whole query must be dialable, or a task title
            // containing a digit would be searched as a phone number.
            ...(/^[\d\s+()-]+$/.test(search)
              ? [
                  {
                    party: {
                      contactPoints: {
                        some: { valueNormalized: { contains: search.replace(/\D/g, '') } },
                      },
                    },
                  } as Prisma.TaskWhereInput,
                ]
              : []),
          ],
        }
      : {};

    const where: Prisma.TaskWhereInput = {
      AND: [
        base,
        bucketWhere,
        searchWhere,
        ...(opts.priority ? [{ priority: opts.priority }] : []),
        ...(opts.assigneeId ? [{ assigneeId: opts.assigneeId }] : []),
      ],
    };

    const rows = await this.prisma.task.findMany({
      where,
      // `id` last, so the order is TOTAL. Without it, rows tying on both
      // dueDate and createdAt — which bulk-created and imported follow-ups
      // routinely do — have no defined order, and a cursor into that set can
      // skip a task or hand back one already worked.
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        detail: true,
        priority: true,
        status: true,
        dueDate: true,
        completedAt: true,
        createdAt: true,
        storeId: true,
        assignee: true,
        assigneeId: true,
        assignedTo: { select: { id: true, name: true } },
        party: {
          select: { id: true, name: true, phone: true, whatsapp: true, code: true },
        },
        lead: { select: { id: true, ref: true, stage: true, source: true, interest: true } },
      },
    });

    const page = rows.slice(0, limit);

    return {
      items: page.map((t) => ({
        id: t.id,
        title: t.title,
        detail: t.detail,
        priority: t.priority,
        status: t.status,
        dueDate: t.dueDate,
        completedAt: t.completedAt,
        createdAt: t.createdAt,
        storeId: t.storeId,
        assignee: t.assignedTo ?? (t.assignee ? { id: null, name: t.assignee } : null),
        customer: t.party
          ? {
              id: t.party.id,
              name: t.party.name,
              customerId: t.party.code,
              contact: maskNumber(
                t.party.whatsapp ?? t.party.phone,
                canSeeFullNumber(user, t.assigneeId),
              ),
              /*
               * Whether `contact` is a number that can actually be dialled.
               *
               * Without this the client had no way to tell `+919820011122`
               * from `••••1122`, and the take-action panel built a
               * `tel:••••1122` link that looked identical to a working one and
               * dialled nothing. A withheld number should read as withheld.
               */
              canDial:
                canSeeFullNumber(user, t.assigneeId) &&
                Boolean(t.party.whatsapp ?? t.party.phone),
            }
          : null,
        lead: t.lead,
        /**
         * Whole days past due at the BRANCH: positive when late, 0 when due
         * today, negative when still ahead. Computed here so every client agrees
         * on what "overdue" means rather than each doing its own date
         * arithmetic against its own clock — and in days, because `dueDate` is
         * a calendar date and there is no hour in it to report.
         */
        overdueDays: dueInDays(t.dueDate, today),
      })),
      /** Which day, and where, the buckets above were drawn against. */
      day: { start: today, end: tomorrow, timezone: tz },
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  // ========================================================= take action

  /** Everything the Take Action panel needs, in one round of parallel reads. */
  async workspace(user: AuthUser, taskId: string) {
    const task = await this.loadTask(user, taskId);

    const [calls, notes, activity, lead, party] = await Promise.all([
      this.prisma.callLog.findMany({
        where: { organisationId: user.organisationId, taskId: task.id },
        orderBy: { startedAt: 'desc' },
        take: 20,
      }),
      task.leadId
        ? this.prisma.leadNote.findMany({
            where: { leadId: task.leadId, lead: { organisationId: user.organisationId } },
            orderBy: { createdAt: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
      task.partyId
        ? this.prisma.activityEvent.findMany({
            // The caller's branches, and for a salesperson their own part of it.
            // This read every event about the customer across the organisation.
            where: {
              organisationId: user.organisationId,
              partyId: task.partyId,
              OR: [{ storeId: { in: user.storeIds } }, { storeId: null }],
              ...(isSalesScoped(user)
                ? { AND: [{ OR: [{ actorUserId: user.id }, { lead: { ownerId: user.id } }] }] }
                : {}),
            },
            orderBy: { occurredAt: 'desc' },
            take: 30,
            select: {
              id: true, type: true, summary: true, channel: true, occurredAt: true,
            },
          })
        : Promise.resolve([]),
      task.leadId
        ? this.prisma.lead.findFirst({
            where: { id: task.leadId, organisationId: user.organisationId },
            select: {
              id: true, ref: true, stage: true, source: true, interest: true,
              value: true, createdAt: true,
              store: { select: { id: true, name: true } },
              owner: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve(null),
      task.partyId
        ? this.customerSummary(user, task.partyId, canSeeFullNumber(user, task.assigneeId))
        : Promise.resolve(null),
    ]);

    const showFull = canSeeFullNumber(user, task.assigneeId);

    return {
      task: {
        id: task.id,
        title: task.title,
        detail: task.detail,
        priority: task.priority,
        status: task.status,
        dueDate: task.dueDate,
        completedAt: task.completedAt,
        storeId: task.storeId,
        assignee: task.assignee,
        assigneeId: task.assigneeId,
      },
      customer: party,
      lead,
      notes,
      activity,
      calls: calls.map((c) => this.presentCall(c, showFull)),
    };
  }

  /**
   * Totals a caller can quote to the customer.
   *
   * Every figure is measured. There is deliberately no "estimated lifetime
   * value": a caller reading a fabricated number to a customer is worse than
   * a caller with no number at all, and an empty state says so honestly.
   */
  private async customerSummary(user: AuthUser, partyId: string, showFull: boolean) {
    const [party, orders, visits, lastVisit] = await Promise.all([
      this.prisma.party.findFirst({
        where: { id: partyId, organisationId: user.organisationId },
        select: {
          id: true, name: true, code: true, phone: true, whatsapp: true,
          city: true, createdAt: true, isBlacklisted: true,
        },
      }),
      // The caller's branches, like every other figure they can see. These
      // totals were organisation-wide.
      this.prisma.sale.aggregate({
        where: { organisationId: user.organisationId, partyId, storeId: { in: user.storeIds } },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.checkIn.count({
        where: { organisationId: user.organisationId, partyId, storeId: { in: user.storeIds } },
      }),
      this.prisma.checkIn.findFirst({
        where: { organisationId: user.organisationId, partyId, storeId: { in: user.storeIds } },
        orderBy: { timeIn: 'desc' },
        select: {
          timeIn: true,
          store: { select: { id: true, name: true } },
          attendedBy: { select: { id: true, name: true } },
        },
      }),
    ]);
    if (!party) return null;

    return {
      id: party.id,
      name: party.name,
      customerId: party.code,
      contact: maskNumber(party.whatsapp ?? party.phone, showFull),
      /** See QueueTask.customer.canDial — a masked number is not a phone link. */
      canDial: showFull && Boolean(party.whatsapp ?? party.phone),
      city: party.city,
      customerSince: party.createdAt,
      blocked: party.isBlacklisted,
      totalOrders: orders._count._all,
      // null, not 0, when there are no orders: "we have no record" and "they
      // spent nothing" are different answers and the screen shows them so.
      totalSpend: orders._count._all ? (orders._sum.totalAmount?.toString() ?? null) : null,
      totalVisits: visits,
      lastVisitAt: lastVisit?.timeIn ?? null,
      lastVisitStore: lastVisit?.store ?? null,
      lastAttendedBy: lastVisit?.attendedBy ?? null,
    };
  }

  /**
   * Log a call and, in the same act, say what happens to the task.
   *
   * One endpoint rather than three, because "I called, they want a callback on
   * Thursday" is one decision. Splitting it lets an agent log a call and forget
   * to reschedule, which is precisely how a follow-up queue rots.
   */
  async logCall(
    user: AuthUser,
    taskId: string,
    input: {
      direction?: string;
      disposition: string;
      notes?: string;
      durationSec?: number;
      provider?: string;
      providerCallId?: string;
      recordingUrl?: string;
      /** 'complete' | 'reschedule' | 'leave' */
      then?: string;
      rescheduleTo?: string;
    },
  ) {
    const task = await this.loadTask(user, taskId);

    const call = await this.prisma.callLog.create({
      data: {
        organisationId: user.organisationId,
        storeId: task.storeId,
        taskId: task.id,
        partyId: task.partyId,
        leadId: task.leadId,
        direction: input.direction === 'inbound' ? 'inbound' : 'outbound',
        // 'manual' is the honest default: a person dialled from their handset
        // and typed the outcome. It carries no provider evidence and the reports
        // must be able to tell that apart from a call the network confirmed.
        provider: input.provider?.trim() || 'manual',
        providerCallId: input.providerCallId?.trim() || null,
        agentUserId: user.id,
        disposition: input.disposition,
        notes: input.notes ?? null,
        durationSec: input.durationSec ?? null,
        recordingUrl: input.recordingUrl ?? null,
        startedAt: new Date(),
        endedAt: new Date(),
      },
    });

    let rescheduledTo: Date | null = null;
    // What the row actually says afterwards. This used to be asserted from the
    // request — `then === 'complete' ? 'done' : 'open'` — so logging a call with
    // `then: 'leave'` on an in-progress task reported "open" while the database
    // still said "in_progress" and nothing had been written.
    let taskStatus: string = task.status;
    if (input.then === 'complete') {
      const done = await this.prisma.task.update({
        where: { id: task.id },
        data: { status: 'done', completedAt: task.completedAt ?? new Date() },
        select: { status: true },
      });
      taskStatus = done.status;
    } else if (input.then === 'reschedule') {
      if (!input.rescheduleTo) {
        throw new BadRequestException('Choose the date to call back on.');
      }
      const chosen = new Date(input.rescheduleTo);
      if (Number.isNaN(chosen.getTime())) {
        throw new BadRequestException('That is not a usable date.');
      }
      /*
       * Reduced to the calendar date AT THE BRANCH before it is written.
       *
       * `dueDate` is `@db.Date`, so Postgres truncates whatever instant it is
       * given by UTC — and the client sends a full ISO timestamp. A callback
       * booked for any IST time between 00:00 and 05:29 therefore landed on the
       * PREVIOUS day and the task was overdue the moment it was rescheduled.
       */
      const tz = await this.scope.resolveTimezone(user, task.storeId ?? undefined);
      rescheduledTo = businessDate(chosen, tz);
      const reopened = await this.prisma.task.update({
        where: { id: task.id },
        data: { dueDate: rescheduledTo, status: 'open', completedAt: null },
        select: { status: true },
      });
      taskStatus = reopened.status;
    }

    if (task.partyId) {
      await this.activity.recordFor(user, {
        partyId: task.partyId,
        leadId: task.leadId ?? undefined,
        storeId: task.storeId ?? undefined,
        type: 'call.logged',
        channel: 'phone',
        summary: `Call — ${input.disposition}${
          rescheduledTo ? `, calling back ${rescheduledTo.toDateString()}` : ''
        }`,
        entityType: 'CallLog',
        entityId: call.id,
      });
    }

    await this.audit.record(user, {
      action: 'calling.call_logged',
      entityType: 'Task',
      entityId: task.id,
      storeId: task.storeId,
      summary: `Logged a call on "${task.title}" — ${input.disposition}.`,
    });

    return {
      callId: call.id,
      taskStatus,
      rescheduledTo,
    };
  }

  /** Call history for one customer, across every task. */
  async callsForParty(user: AuthUser, partyId: string) {
    const owned = await this.prisma.party.count({
      where: { id: partyId, ...readableParty(user) },
    });
    if (!owned) throw new NotFoundException('That customer does not exist.');
    const rows = await this.prisma.callLog.findMany({
      where: {
        organisationId: user.organisationId,
        partyId,
        // A salesperson's own calls and the calls on their tasks; a manager's
        // branches. This was every call to the customer in the organisation.
        ...(isSalesScoped(user)
          ? { OR: [{ agentUserId: user.id }, { task: { assigneeId: user.id } }] }
          : { OR: [{ storeId: { in: user.storeIds } }, { storeId: null }] }),
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    // A call-history screen is a manager view; an agent sees the numbers on the
    // tasks they own, which is where they need them.
    const showFull = MANAGER_ROLES.includes(user.role);
    return rows.map((c) => this.presentCall(c, showFull));
  }

  /**
   * A recording is shown only while the provider's own URL is still valid.
   *
   * An expired URL rendered as a player is a button that does nothing, and the
   * agent concludes the system lost the recording. Saying "no longer available"
   * is the truth and is actionable.
   */
  private presentCall(
    c: Prisma.CallLogGetPayload<object>,
    showFullNumber: boolean,
  ) {
    const expired = Boolean(c.recordingExpiresAt && c.recordingExpiresAt <= new Date());
    return {
      id: c.id,
      direction: c.direction,
      provider: c.provider,
      disposition: c.disposition,
      notes: c.notes,
      startedAt: c.startedAt,
      durationSec: c.durationSec,
      from: maskNumber(c.fromNumber, showFullNumber),
      to: maskNumber(c.toNumber, showFullNumber),
      recording:
        c.recordingUrl && !expired
          ? { url: c.recordingUrl, expiresAt: c.recordingExpiresAt }
          : null,
      recordingState: !c.recordingUrl ? 'none' : expired ? 'expired' : 'available',
      transcript: c.transcript,
      transcriptSource: c.transcriptSource,
      summary: c.summary,
      summarySource: c.summarySource,
    };
  }

  // =============================================================== helpers

  private async loadTask(user: AuthUser, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!task) throw new NotFoundException('That task does not exist.');
    if (task.storeId) this.scope.assertStoreAllowed(user, task.storeId);
    // A salesperson works the tasks put on them. By id, a colleague's reads as
    // absent, exactly as it would in their queue.
    if (isSalesScoped(user) && task.assigneeId !== user.id) {
      throw new NotFoundException('That task does not exist.');
    }
    return task;
  }

  /**
   * Tenant + branch + "mine".
   *
   * `mine` resolves to the CALLER's id here rather than accepting one, so a
   * client cannot ask for another agent's queue by passing their id.
   */
  private taskScope(
    user: AuthUser,
    opts: { mine?: boolean; storeId?: string },
  ): Prisma.TaskWhereInput {
    if (opts.storeId) this.scope.assertStoreAllowed(user, opts.storeId);
    return {
      organisationId: user.organisationId,
      /*
       * The same fix DashboardService.listTasks already carries.
       *
       * `storeFilter` is `{ storeId: { in: [...] } }`, and a task with a NULL
       * storeId matches no `in` list. Organisation-wide tasks are a supported,
       * manager-only creation path — so every one of them was written
       * successfully and then appeared in neither the queue nor any of the four
       * counts. A head-office follow-up was invisible to the people meant to
       * make it. Bounded by organisation, so widening the store test cannot
       * cross a tenant.
       */
      OR: [this.scope.storeFilter(user, opts.storeId), { storeId: null }],
      // A salesperson's queue is always their own, whatever the request says.
      ...(opts.mine || isSalesScoped(user) ? { assigneeId: user.id } : {}),
    };
  }
}
