import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import { KpiWindow, ratio, resolveKpiWindow } from './kpi-window';
import { ASKED_FEEDBACK } from '../crm/feedback.service';

/**
 * The management KPI system (Block 15).
 *
 * ## Every figure here is a database aggregate
 *
 * Not one of them is `findMany(...).length`. That is the single most common way
 * a dashboard goes quietly wrong: a list capped at 1,000 rows counts 1,000 for
 * every tenant above it, and the number stops moving at exactly the point the
 * business becomes big enough to care about it. `count`, `groupBy` and
 * `aggregate` are uncapped by construction, so the figure is right at any size
 * and the database does the work rather than the process.
 *
 * ## Zero is not the same as "cannot say"
 *
 * Every ratio returns `null` when its denominator is zero, and carries its
 * numerator and denominator with it. A branch that converted none of forty
 * leads and a branch that had no leads at all are different Tuesdays, and a
 * dashboard that prints 0% for both teaches people to ignore it.
 *
 * ## Three things that are deliberately NOT counted
 *
 *  1. ARCHIVED CONTACTS are not active prospects. Somebody asked to be left
 *     alone, or was a duplicate; counting them inflates every pipeline figure
 *     and, worse, makes the outreach lists look larger than what can lawfully
 *     be contacted.
 *
 *  2. OPTED-OUT CONTACTS are not campaign-reachable. The consent state lives in
 *     `ActivityEvent`, which is where the outbound policy reads it, so the
 *     number on the screen and the number the sender will actually reach are
 *     the same number.
 *
 *  3. A DRY RUN IS NOT A DELIVERY. A message the adapter logged because no
 *     credential was configured never reached anybody. Counting it as sent
 *     would make an entirely unconnected tenant look like a busy one.
 *
 * ## Scope
 *
 * Tenant and store scope are applied on the SERVER for every query, from the
 * caller's own principal. A salesperson sees their own work; a store manager
 * their branches; head office the organisation and never past it.
 */

/**
 * What counts as an ad the PROVIDER measured.
 *
 * `evidence` is the whole point of the distinction: 'declared' is a human
 * choosing a source from a dropdown at the counter, and adding it to what Meta
 * actually reported produces a "measured" figure that is partly somebody's
 * guess. A lead with no measured touch is NOT evidence of organic traffic — the
 * provider may simply not have told us — which is why this is reported as its
 * own number rather than subtracted from the total.
 */
const MEASURED_AD = {
  evidence: 'measured',
  externalAdId: { not: null },
} as const;

/** Roles that may see organisation-wide figures rather than only their own. */
function isManagement(user: AuthUser): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK.store_manager;
}

export interface KpiFilters {
  from?: string;
  to?: string;
  storeId?: string;
  ownerId?: string;
  source?: string;
  channel?: string;
  campaignId?: string;
  tagId?: string;
  timezone?: string;
}

@Injectable()
export class ManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /* ===================================================== scope and window */

  /**
   * Everything every section needs, resolved once.
   *
   * A SALESPERSON IS PINNED TO THEMSELVES. Not by hiding the filter in the UI —
   * by overriding it here, so the same request from the same person gets the
   * same answer whatever they put in the query string. A dashboard is a read of
   * the whole database with a filter on it, which makes it the easiest place in
   * a product to leak a colleague's pipeline.
   */
  private async context(user: AuthUser, filters: KpiFilters) {
    const storeIds = this.scope.effectiveStoreIds(user, filters.storeId);
    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds }, organisationId: user.organisationId, attendanceOnly: false },
      select: { id: true, name: true, timezone: true, isAggregate: true },
    });
    const organisation = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { timezone: true },
    });

    const window = resolveKpiWindow({
      from: filters.from,
      to: filters.to,
      requestedTimezone: filters.timezone,
      storeTimezones: stores.filter((s) => !s.isAggregate).map((s) => s.timezone),
      organisationTimezone: organisation?.timezone,
    });

    const ownerId = isManagement(user) ? filters.ownerId : user.id;
    if (!isManagement(user) && filters.ownerId && filters.ownerId !== user.id) {
      throw new ForbiddenException('You can only see your own figures.');
    }

    return {
      storeIds: stores.map((s) => s.id),
      stores,
      window,
      ownerId,
      organisationId: user.organisationId,
      management: isManagement(user),
      /*
       * Rows with no branch (an unrouted WhatsApp thread, an organisation-level
       * task) belong to nobody's branch, so only somebody looking at the whole
       * organisation sees them. A branch manager, or head office narrowed to one
       * branch, would otherwise count the whole organisation's unrouted work as
       * their own.
       */
      organisationWide: user.allStores && !filters.storeId,
    };
  }

  /** The caller's branches, plus unrouted rows when the view is organisation-wide. */
  private branchClause(ctx: Ctx) {
    return ctx.organisationWide
      ? { OR: [{ storeId: { in: ctx.storeIds } }, { storeId: null }] }
      : { storeId: { in: ctx.storeIds } };
  }

  /** The store clause every query shares. */
  private storeClause(storeIds: string[]): Prisma.StringFilter {
    return { in: storeIds };
  }

  /* ============================================================ the report */

  async kpis(user: AuthUser, filters: KpiFilters) {
    const ctx = await this.context(user, filters);
    if (!ctx.storeIds.length) {
      // Not zero — unanswerable. A user attached to no branch has no figures,
      // which is a different thing from a branch that did nothing.
      return {
        window: ctx.window,
        scope: { stores: [], unavailable: 'You are not assigned to any branch yet.' },
      };
    }

    const [leads, engagement, followUps, floor, quotes, feedback, operations] =
      await Promise.all([
        this.leadSection(ctx, filters),
        this.engagementSection(ctx, filters),
        this.followUpSection(ctx),
        this.floorSection(ctx),
        this.quoteSection(ctx),
        this.feedbackSection(ctx),
        // Imports, dead jobs and month-end runs are organisation-level plumbing;
        // a branch-scoped view has no branch share of them to report.
        ctx.organisationWide ? this.operationsSection(ctx) : Promise.resolve(undefined),
      ]);

    return {
      window: ctx.window,
      scope: {
        stores: ctx.stores.map((s) => ({ id: s.id, name: s.name })),
        /** Pinned for a salesperson, whatever the request asked for. */
        ownerId: ctx.ownerId ?? null,
        organisationWide: ctx.management && !filters.storeId,
      },
      leads,
      engagement,
      followUps,
      floor,
      quotes,
      feedback,
      operations,
      conversion: await this.conversionSection(ctx, filters),
    };
  }

  /* ------------------------------------------------------ lead acquisition */

  private async leadSection(ctx: Ctx, filters: KpiFilters) {
    const where: Prisma.LeadWhereInput = {
      organisationId: ctx.organisationId,
      storeId: this.storeClause(ctx.storeIds),
      createdAt: { gte: ctx.window.from, lt: ctx.window.to },
      ...(ctx.ownerId ? { ownerId: ctx.ownerId } : {}),
      ...(filters.source ? { source: filters.source as never } : {}),
      ...(filters.tagId ? { tagAssignments: { some: { tagId: filters.tagId } } } : {}),
      /*
       * A lead whose customer has been archived is not a live prospect.
       *
       * The row stays — archiving hides, it does not delete, and the consent
       * evidence on it is exactly what stops the person being messaged again —
       * but counting it here would inflate every acquisition figure with people
       * who have asked to be left alone.
       */
      OR: [{ partyId: null }, { party: { archivedAt: null } }],
    };

    const [total, bySource, byStore, byOwner, byStage, newCustomers] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.groupBy({ by: ['source'], where, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['storeId'], where, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['ownerId'], where, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['stage'], where, _count: { _all: true } }),
      // A lead is "new business" when the customer record was created inside the
      // same window. Anything older is somebody coming back, which is a
      // different number and a different conversation.
      this.prisma.lead.count({
        where: { ...where, party: { createdAt: { gte: ctx.window.from } } },
      }),
    ]);

    const days = Math.max(
      1,
      Math.round((ctx.window.to.getTime() - ctx.window.from.getTime()) / 86_400_000),
    );

    return {
      total,
      /** Mean per day across the window. Stated as a mean, not as "today". */
      perDayAverage: Math.round((total / days) * 10) / 10,
      bySource: bySource.map((r) => ({ key: r.source, count: r._count._all })),
      byStore: byStore.map((r) => ({
        key: r.storeId,
        label: ctx.stores.find((s) => s.id === r.storeId)?.name ?? r.storeId,
        count: r._count._all,
      })),
      byOwner: byOwner.map((r) => ({ key: r.ownerId ?? 'unassigned', count: r._count._all })),
      byStage: byStage.map((r) => ({ key: r.stage, count: r._count._all })),
      newCustomers,
      returningCustomers: total - newCustomers,
      /**
       * Ad attribution is reported separately from the `source` field and is
       * never merged with it. `source` is what somebody DECLARED when the lead
       * was filed; this is what the provider MEASURED. Adding them together
       * produces a number that is neither.
       */
      measuredAdAttribution: await this.prisma.lead.count({
        where: { ...where, attributionTouches: { some: MEASURED_AD } },
      }),
    };
  }

  /* ---------------------------------------------------- customer engagement */

  private async engagementSection(ctx: Ctx, filters: KpiFilters) {
    const conversationWhere: Prisma.ConversationWhereInput = {
      organisationId: ctx.organisationId,
      // A staff notice thread is not customer engagement.
      audience: 'customer',
      createdAt: { gte: ctx.window.from, lt: ctx.window.to },
      // AND, not a top-level OR: the unanswered count below adds an OR of its
      // own, and a second OR key would silently replace the scope.
      AND: [this.branchClause(ctx)],
      ...(filters.channel ? { channel: filters.channel } : {}),
    };

    const [byChannel, unanswered, slaRows, breached, escalated] = await Promise.all([
      this.prisma.conversation.groupBy({
        by: ['channel'],
        where: conversationWhere,
        _count: { _all: true },
      }),
      // Open, and the last thing said was the customer's. Not "no reply ever" —
      // a thread answered last week and re-opened today is waiting again.
      this.prisma.conversation.count({
        where: {
          ...conversationWhere,
          status: 'open',
          lastInboundAt: { not: null },
          OR: [
            { lastMessageAt: null },
            { lastMessageAt: { lte: this.prisma.conversation.fields.lastInboundAt } },
          ],
        },
      }),
      this.prisma.conversationResponseSla.aggregate({
        where: {
          organisationId: ctx.organisationId,
          // Scoped like everything else. An unrouted thread has no branch, and
          // is included for anyone who can see the whole organisation rather
          // than being invisible to everybody.
          ...this.branchClause(ctx),
          startedAt: { gte: ctx.window.from, lt: ctx.window.to },
          respondedAt: { not: null },
        },
        _avg: { responseSeconds: true },
        _count: { _all: true },
      }),
      this.prisma.conversationResponseSla.count({
        where: {
          organisationId: ctx.organisationId,
          // Scoped like everything else. An unrouted thread has no branch, and
          // is included for anyone who can see the whole organisation rather
          // than being invisible to everybody.
          ...this.branchClause(ctx),
          startedAt: { gte: ctx.window.from, lt: ctx.window.to },
          breachedAt: { not: null },
        },
      }),
      this.prisma.conversationResponseSla.count({
        where: {
          organisationId: ctx.organisationId,
          // Scoped like everything else. An unrouted thread has no branch, and
          // is included for anyone who can see the whole organisation rather
          // than being invisible to everybody.
          ...this.branchClause(ctx),
          startedAt: { gte: ctx.window.from, lt: ctx.window.to },
          escalatedAt: { not: null },
        },
      }),
    ]);

    // An AI draft only counts once a person approved it: an unreviewed draft is
    // not a reply to the customer, and counting it would report a response time
    // for a conversation nobody answered.
    const [humanFirst, aiApprovedFirst] = await Promise.all([
      this.prisma.conversationResponseSla.count({
        where: {
          organisationId: ctx.organisationId,
          // Scoped like everything else. An unrouted thread has no branch, and
          // is included for anyone who can see the whole organisation rather
          // than being invisible to everybody.
          ...this.branchClause(ctx),
          startedAt: { gte: ctx.window.from, lt: ctx.window.to },
          responderType: 'agent',
        },
      }),
      this.prisma.conversationResponseSla.count({
        where: {
          organisationId: ctx.organisationId,
          // Scoped like everything else. An unrouted thread has no branch, and
          // is included for anyone who can see the whole organisation rather
          // than being invisible to everybody.
          ...this.branchClause(ctx),
          startedAt: { gte: ctx.window.from, lt: ctx.window.to },
          responderType: 'ai',
        },
      }),
    ]);

    return {
      byChannel: byChannel.map((r) => ({ key: r.channel, count: r._count._all })),
      unanswered,
      /** Null when nothing was answered in the window — not zero seconds. */
      averageFirstResponseSeconds:
        slaRows._count._all > 0 && slaRows._avg.responseSeconds != null
          ? Math.round(slaRows._avg.responseSeconds)
          : null,
      answeredWithinTarget: slaRows._count._all - breached,
      breached,
      escalated,
      firstResponseByHuman: humanFirst,
      firstResponseByApprovedAi: aiApprovedFirst,
      slaMeasured: slaRows._count._all,
    };
  }

  /* ------------------------------------------------ follow-ups and calling */

  private async followUpSection(ctx: Ctx) {
    const taskWhere: Prisma.TaskWhereInput = {
      organisationId: ctx.organisationId,
      ...this.branchClause(ctx),
      createdAt: { gte: ctx.window.from, lt: ctx.window.to },
      ...(ctx.ownerId ? { assigneeId: ctx.ownerId } : {}),
    };

    const [total, completed, open, overdue, digestRuns, calls] = await Promise.all([
      this.prisma.task.count({ where: taskWhere }),
      this.prisma.task.count({ where: { ...taskWhere, status: 'done' } }),
      this.prisma.task.count({ where: { ...taskWhere, status: { not: 'done' } } }),
      this.prisma.task.count({
        where: { ...taskWhere, status: { not: 'done' }, dueDate: { lt: new Date() } },
      }),
      this.prisma.staffDigestRun.groupBy({
        by: ['whatsappStatus'],
        where: {
          organisationId: ctx.organisationId,
          ...this.branchClause(ctx),
          createdAt: { gte: ctx.window.from, lt: ctx.window.to },
          ...(ctx.ownerId ? { userId: ctx.ownerId } : {}),
        },
        _count: { _all: true },
      }),
      this.prisma.callLog.groupBy({
        by: ['disposition'],
        where: {
          organisationId: ctx.organisationId,
          ...this.branchClause(ctx),
          startedAt: { gte: ctx.window.from, lt: ctx.window.to },
          ...(ctx.ownerId ? { agentUserId: ctx.ownerId } : {}),
        },
        _count: { _all: true },
      }),
    ]);

    const callsByOutcome = Object.fromEntries(
      calls.map((r) => [r.disposition ?? 'unrecorded', r._count._all]),
    );
    const callsTotal = calls.reduce((sum, r) => sum + r._count._all, 0);

    return {
      total,
      completed,
      open,
      overdue,
      completionRate: ratio(completed, total),
      digest: Object.fromEntries(
        digestRuns.map((r) => [r.whatsappStatus ?? 'not_attempted', r._count._all]),
      ),
      calls: {
        total: callsTotal,
        byOutcome: callsByOutcome,
        answered: callsByOutcome.connected ?? 0,
        /** A call logged by hand is not a call the network confirmed. */
        manual: await this.prisma.callLog.count({
          where: {
            organisationId: ctx.organisationId,
            ...this.branchClause(ctx),
            startedAt: { gte: ctx.window.from, lt: ctx.window.to },
            ...(ctx.ownerId ? { agentUserId: ctx.ownerId } : {}),
            provider: 'manual',
          },
        }),
      },
    };
  }

  /* -------------------------------------------------------- store activity */

  private async floorSection(ctx: Ctx) {
    const where: Prisma.CheckInWhereInput = {
      organisationId: ctx.organisationId,
      storeId: this.storeClause(ctx.storeIds),
      timeIn: { gte: ctx.window.from, lt: ctx.window.to },
    };

    const [total, byStore, byOutcome, withLead, withSale] = await Promise.all([
      this.prisma.checkIn.count({ where }),
      this.prisma.checkIn.groupBy({ by: ['storeId'], where, _count: { _all: true } }),
      this.prisma.checkIn.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      this.prisma.checkIn.count({ where: { ...where, leadId: { not: null } } }),
      // A visit that became a sale, matched through the customer rather than a
      // direct link: the till does not know about the check-in.
      this.prisma.checkIn.count({
        where: {
          ...where,
          partyId: { not: null },
          party: {
            sales: {
              some: {
                isCancelled: false,
                docType: 'sale',
                docDate: { gte: ctx.window.from, lt: ctx.window.to },
              },
            },
          },
        },
      }),
    ]);

    return {
      visits: total,
      byStore: byStore.map((r) => ({
        key: r.storeId,
        label: ctx.stores.find((s) => s.id === r.storeId)?.name ?? r.storeId,
        count: r._count._all,
      })),
      byOutcome: byOutcome.map((r) => ({ key: r.outcome, count: r._count._all })),
      visitToLead: ratio(withLead, total),
      visitToSale: ratio(withSale, total),
      /** Left without buying and without an enquiry being opened. */
      walkOuts: total - withLead,
    };
  }

  /* ------------------------------------------------------------- quotations */

  private async quoteSection(ctx: Ctx) {
    const where: Prisma.QuoteWhereInput = {
      organisationId: ctx.organisationId,
      storeId: this.storeClause(ctx.storeIds),
      createdAt: { gte: ctx.window.from, lt: ctx.window.to },
      ...(ctx.ownerId ? { assignedRepId: ctx.ownerId } : {}),
    };

    const [byStatus, total, approved, turnaround] = await Promise.all([
      this.prisma.quote.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.quote.count({ where }),
      this.prisma.quote.aggregate({
        where: { ...where, approvedTotal: { not: null } },
        _avg: { approvedTotal: true },
        _count: { _all: true },
      }),
      this.approvalTurnaround(ctx),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    return {
      total,
      byStatus: counts,
      averageApprovedAmount:
        approved._count._all > 0 && approved._avg.approvedTotal != null
          ? Number(approved._avg.approvedTotal)
          : null,
      approvalTurnaroundHours: turnaround,
    };
  }

  /**
   * Request-to-decision time over EVERY decided quote in scope.
   *
   * This used to read the latest 1,000 decisions into the process and average
   * them, because Prisma's aggregate cannot subtract two columns. That is a
   * sample, and a sample that silently stops at a round number is the failure
   * this whole service exists to avoid. Postgres does the arithmetic instead:
   * count, total, mean and median in one pass, at any size.
   */
  private async approvalTurnaround(ctx: Ctx) {
    const [row] = await this.prisma.$queryRaw<
      { decisions: bigint; total_ms: number | null; mean_ms: number | null; median_ms: number | null }[]
    >(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS decisions,
        SUM(EXTRACT(EPOCH FROM ("decidedAt" - "requestedAt")) * 1000)::float8 AS total_ms,
        AVG(EXTRACT(EPOCH FROM ("decidedAt" - "requestedAt")) * 1000)::float8 AS mean_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM ("decidedAt" - "requestedAt"))
        )::float8 * 1000 AS median_ms
      FROM "Quote"
      WHERE "organisationId" = ${ctx.organisationId}
        AND "storeId" IN (${Prisma.join(ctx.storeIds)})
        AND "createdAt" >= ${ctx.window.from}
        AND "createdAt" < ${ctx.window.to}
        AND "requestedAt" IS NOT NULL
        AND "decidedAt" IS NOT NULL
        ${ctx.ownerId ? Prisma.sql`AND "assignedRepId" = ${ctx.ownerId}` : Prisma.empty}
    `);

    const decisions = Number(row?.decisions ?? 0);
    if (!decisions) return null;
    const hours = (ms: number | null) => (ms == null ? null : Math.round((ms / 3_600_000) * 10) / 10);
    return {
      average: hours(row.mean_ms),
      median: hours(row.median_ms),
      totalHours: hours(row.total_ms),
      decisions,
      /** Every decision in scope was measured. Never a sample. */
      sampled: false as const,
    };
  }

  /* ---------------------------------------------------------------- feedback */

  private async feedbackSection(ctx: Ctx) {
    const where: Prisma.FeedbackRequestWhereInput = {
      organisationId: ctx.organisationId,
      ...this.branchClause(ctx),
      createdAt: { gte: ctx.window.from, lt: ctx.window.to },
      // An automatic ask still waiting for its day has asked nobody anything.
      AND: [ASKED_FEEDBACK],
    };

    const [requested, delivered, responded, positive, escalated, reviewOffered] =
      await Promise.all([
        this.prisma.feedbackRequest.count({ where }),
        // Delivered means the provider took it, not that we composed it.
        this.prisma.feedbackRequest.count({ where: { ...where, sentAt: { not: null } } }),
        this.prisma.feedbackRequest.count({ where: { ...where, respondedAt: { not: null } } }),
        this.prisma.feedbackRequest.count({ where: { ...where, rating: { gte: 4 } } }),
        this.prisma.feedbackRequest.count({
          where: { ...where, escalatedTaskId: { not: null } },
        }),
        this.prisma.feedbackRequest.count({ where: { ...where, reviewLinkOffered: true } }),
      ]);

    return {
      requested,
      delivered,
      responded,
      positive,
      negativeOrEscalated: escalated,
      reviewLinksOffered: reviewOffered,
      // Of what was actually DELIVERED, not of what was created: a request that
      // never left the building cannot be answered, and including it makes the
      // rate look like a customer problem rather than a delivery one.
      responseRate: ratio(responded, delivered),
    };
  }

  /* ----------------------------------------------------- reporting and ops */

  private async operationsSection(ctx: Ctx) {
    const window = { gte: ctx.window.from, lt: ctx.window.to };

    const [reportRuns, latestReport, imports, deadJobs] = await Promise.all([
      this.prisma.scheduledReportRun.groupBy({
        by: ['status'],
        where: { organisationId: ctx.organisationId, createdAt: window },
        _count: { _all: true },
      }),
      this.prisma.scheduledReportRun.findFirst({
        where: { organisationId: ctx.organisationId, status: { in: ['sent', 'dry_run'] } },
        orderBy: { createdAt: 'desc' },
        select: { periodKey: true, status: true, createdAt: true },
      }),
      this.prisma.importBatch.aggregate({
        where: { organisationId: ctx.organisationId, createdAt: window },
        _count: { _all: true },
        _sum: { imported: true, failed: true, duplicate: true, skipped: true },
      }),
      this.prisma.jobTask.count({
        where: { organisationId: ctx.organisationId, status: 'dead', createdAt: window },
      }),
    ]);

    return {
      scheduledReports: Object.fromEntries(
        reportRuns.map((r) => [r.status, r._count._all]),
      ),
      /**
       * The newest month-end that actually went out. `dry_run` is reported as
       * its own state rather than as a success: nothing left the building.
       */
      latestReport: latestReport
        ? {
            periodKey: latestReport.periodKey,
            status: latestReport.status,
            at: latestReport.createdAt,
            delivered: latestReport.status === 'sent',
          }
        : null,
      imports: {
        batches: imports._count._all,
        imported: imports._sum.imported ?? 0,
        rejectedRows: (imports._sum.failed ?? 0) + (imports._sum.duplicate ?? 0),
        skipped: imports._sum.skipped ?? 0,
      },
      deadJobs,
    };
  }

  /* -------------------------------------------------------------- conversion */

  private async conversionSection(ctx: Ctx, filters: KpiFilters) {
    const base: Prisma.LeadWhereInput = {
      organisationId: ctx.organisationId,
      storeId: this.storeClause(ctx.storeIds),
      createdAt: { gte: ctx.window.from, lt: ctx.window.to },
      ...(ctx.ownerId ? { ownerId: ctx.ownerId } : {}),
      ...(filters.source ? { source: filters.source as never } : {}),
      OR: [{ partyId: null }, { party: { archivedAt: null } }],
    };
    const won: Prisma.LeadWhereInput = { ...base, outcome: 'won' };

    const [totalBySource, wonBySource, totalByStore, wonByStore, totalByOwner, wonByOwner] =
      await Promise.all([
        this.prisma.lead.groupBy({ by: ['source'], where: base, _count: { _all: true } }),
        this.prisma.lead.groupBy({ by: ['source'], where: won, _count: { _all: true } }),
        this.prisma.lead.groupBy({ by: ['storeId'], where: base, _count: { _all: true } }),
        this.prisma.lead.groupBy({ by: ['storeId'], where: won, _count: { _all: true } }),
        this.prisma.lead.groupBy({ by: ['ownerId'], where: base, _count: { _all: true } }),
        this.prisma.lead.groupBy({ by: ['ownerId'], where: won, _count: { _all: true } }),
      ]);

    const join = <K extends string>(
      totals: { key: string | null; count: number }[],
      wins: { key: string | null; count: number }[],
      label?: (key: string) => string,
    ) =>
      totals.map((t) => {
        const key = t.key ?? 'unassigned';
        const wonCount = wins.find((w) => (w.key ?? 'unassigned') === key)?.count ?? 0;
        return { key, label: label?.(key) ?? key, ...ratio(wonCount, t.count) };
      });

    const asRows = (rows: { _count: { _all: number } }[], field: string) =>
      rows.map((r) => ({
        key: (r as Record<string, unknown>)[field] as string | null,
        count: r._count._all,
      }));

    return {
      /**
       * DECLARED attribution — the `source` somebody chose when the lead was
       * filed. Kept apart from the measured ad attribution below, because
       * merging a field a person typed with a provider's own measurement
       * produces a number that is true of neither.
       */
      bySource: join(asRows(totalBySource, 'source'), asRows(wonBySource, 'source')),
      byStore: join(asRows(totalByStore, 'storeId'), asRows(wonByStore, 'storeId'), (id) =>
        ctx.stores.find((s) => s.id === id)?.name ?? id,
      ),
      byOwner: join(asRows(totalByOwner, 'ownerId'), asRows(wonByOwner, 'ownerId')),
      /** MEASURED attribution, reported separately and never added to the above. */
      measured: await this.measuredConversion(ctx, base),
    };
  }

  private async measuredConversion(ctx: Ctx, base: Prisma.LeadWhereInput) {
    const withAd: Prisma.LeadWhereInput = {
      ...base,
      attributionTouches: { some: MEASURED_AD },
    };
    const [total, won] = await Promise.all([
      this.prisma.lead.count({ where: withAd }),
      this.prisma.lead.count({ where: { ...withAd, outcome: 'won' } }),
    ]);
    return {
      note:
        'Only leads the provider itself attributed to an ad. A lead with no ' +
        'measured ad is NOT evidence of organic traffic — the provider may simply ' +
        'not have told us.',
      ...ratio(won, total),
    };
  }

  /* ============================================================== the export */

  /**
   * The rows behind a figure, as a spreadsheet.
   *
   * Audited, because a lead export is the tenant's customer list leaving the
   * building, and a salesperson is deliberately confined to their own rows here
   * exactly as they are on the screen.
   */
  async exportLeads(user: AuthUser, filters: KpiFilters) {
    const ctx = await this.context(user, filters);
    const rows = await this.prisma.lead.findMany({
      where: {
        organisationId: ctx.organisationId,
        storeId: this.storeClause(ctx.storeIds),
        createdAt: { gte: ctx.window.from, lt: ctx.window.to },
        ...(ctx.ownerId ? { ownerId: ctx.ownerId } : {}),
        ...(filters.source ? { source: filters.source as never } : {}),
        OR: [{ partyId: null }, { party: { archivedAt: null } }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        ref: true,
        customerName: true,
        phone: true,
        source: true,
        stage: true,
        outcome: true,
        value: true,
        storeId: true,
        ownerId: true,
        createdAt: true,
        closedAt: true,
      },
    });

    await this.audit.record(user, {
      action: 'management.kpi_export',
      entityType: 'Organisation',
      entityId: ctx.organisationId,
      summary: `Exported ${rows.length} lead row(s) for ${ctx.window.fromDate} to ${ctx.window.toDate}.`,
      metadata: {
        rows: rows.length,
        from: ctx.window.fromDate,
        to: ctx.window.toDate,
        timezone: ctx.window.timezone,
        ownerScoped: ctx.ownerId ?? null,
      },
    });

    return {
      window: ctx.window,
      rows: rows.map((r) => ({
        ...r,
        value: r.value == null ? null : Number(r.value),
        storeName: ctx.stores.find((s) => s.id === r.storeId)?.name ?? r.storeId,
      })),
    };
  }
}

interface Ctx {
  organisationWide: boolean;
  storeIds: string[];
  stores: { id: string; name: string; timezone: string | null; isAggregate: boolean }[];
  window: KpiWindow;
  ownerId?: string;
  organisationId: string;
  management: boolean;
}
