import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationKind, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import { businessDate, resolveTz } from '../common/tz.util';
import { NotificationBus, NotificationEvent } from './notification-bus';
import { FeedQueryDto } from './dto/notifications.dto';

/** A single actionable-count row surfaced alongside the feed. */
interface NotificationItem {
  type:
    | 'discount'
    | 'return'
    | 'leave'
    | 'reminder'
    | 'store_pending'
    | 'special_request'
    | 'dsr_missing';
  label: string;
  count: number;
  href: string;
}

/** What a caller hands to {@link NotificationsService.emit}. */
export interface EmitInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  storeId?: string | null;
  entityType?: string;
  entityId?: string;
  priority?: 'normal' | 'high';
  actorId?: string | null;
  actorName?: string | null;
  metadata?: Prisma.InputJsonValue;
  /**
   * Idempotency key, unique per recipient. Supply it whenever the same business
   * event could be emitted twice (a retry, a re-run job) — the second emit
   * updates the row in place instead of stacking a duplicate in the bell.
   */
  dedupeKey?: string;
}

/** End-of-today as a UTC instant — inclusive upper bound for `@db.Date` dueDate. */
function endOfTodayUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59, 999));
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly bus: NotificationBus,
  ) {}

  // ==========================================================================
  // Emission
  // ==========================================================================

  /**
   * Persist a notification for each recipient, then push it to any connection
   * they currently hold.
   *
   * Persist-then-push, in that order and never the reverse: a user with no open
   * tab must still find the notification waiting when they next load the app.
   * The push is the optimisation; the row is the guarantee.
   *
   * Best-effort by contract — a notification failure must never roll back the
   * business action that triggered it, so everything here is caught and logged.
   * Call it AFTER the primary write has committed.
   */
  async emit(userIds: string[], input: EmitInput): Promise<void> {
    const recipients = [...new Set(userIds.filter(Boolean))];
    if (recipients.length === 0) return;

    await Promise.all(
      recipients.map(async (userId) => {
        try {
          const data = {
            userId,
            kind: input.kind,
            title: input.title,
            body: input.body ?? null,
            href: input.href ?? null,
            storeId: input.storeId ?? null,
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            priority: input.priority ?? 'normal',
            actorId: input.actorId ?? null,
            actorName: input.actorName ?? null,
            metadata: input.metadata,
            dedupeKey: input.dedupeKey ?? null,
          };

          // With a dedupe key the emit is idempotent: re-firing refreshes the
          // existing row (and un-reads it, because the situation changed) rather
          // than filling the bell with copies of one event.
          const row = input.dedupeKey
            ? await this.prisma.notification.upsert({
                where: { userId_dedupeKey: { userId, dedupeKey: input.dedupeKey } },
                update: { ...data, readAt: null, dismissedAt: null, createdAt: new Date() },
                create: data,
              })
            : await this.prisma.notification.create({ data });

          const unreadCount = await this.prisma.notification.count({
            where: { userId, readAt: null, dismissedAt: null },
          });

          const event: NotificationEvent = {
            id: row.id,
            userId,
            kind: row.kind,
            title: row.title,
            body: row.body,
            href: row.href,
            priority: row.priority,
            storeId: row.storeId,
            entityType: row.entityType,
            entityId: row.entityId,
            actorName: row.actorName,
            createdAt: row.createdAt.toISOString(),
            unreadCount,
          };
          this.bus.publish(event);
        } catch (err) {
          this.logger.warn(
            `notification emit failed for ${userId} (${input.kind}): ${
              (err as Error)?.message ?? err
            }`,
          );
        }
      }),
    );
  }

  /**
   * Everyone who could act on something needing `requiredRole` at `storeId`.
   *
   * Resolved by walking UP from the required rank: a request needing a store
   * manager also reaches the area manager and head office, because either of
   * them can decide it and a request should never stall waiting on one person.
   *
   * `excludeUserId` drops the requester — nobody is notified of their own
   * request, and they could not approve it anyway (see `approval.util.ts`).
   *
   * ORGANISATION BOUNDARY: recipients are always confined to a single tenant.
   * head_office is reached regardless of a store link, so without an organisation
   * filter this would fan a store's request out to EVERY tenant's head office.
   * The organisation is taken from `organisationId` when given, otherwise derived
   * from the store; if neither is available no recipients are returned, so a
   * notification can never cross into another organisation.
   */
  async recipientsFor(
    storeId: string | null,
    requiredRole: Role,
    excludeUserId?: string,
    organisationId?: string | null,
  ): Promise<string[]> {
    const minRank = ROLE_RANK[requiredRole];
    // A storeperson shares the front-line rank for delegation only; they are
    // told about something only when it is addressed to storepeople.
    const eligibleRoles = (Object.keys(ROLE_RANK) as Role[]).filter(
      (r) => ROLE_RANK[r] >= minRank && (r !== Role.storeperson || requiredRole === Role.storeperson),
    );

    // Resolve the tenant this notification belongs to. A store's organisation is
    // the boundary for head_office recipients; fall back to it when the caller
    // did not pass one explicitly.
    const orgId =
      organisationId ??
      (storeId
        ? (
            await this.prisma.store.findUnique({
              where: { id: storeId },
              select: { organisationId: true },
            })
          )?.organisationId ?? null
        : null);
    // Fail closed: with no tenant context we cannot safely fan out to head_office
    // (which spans stores), so nobody is notified rather than every tenant's HO.
    if (!orgId) return [];

    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        organisationId: orgId,
        role: { in: eligibleRoles },
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
        // head_office sees every store OF ITS ORGANISATION, so it is reached
        // regardless of the store link; everyone else must actually be attached
        // to this branch.
        ...(storeId
          ? { OR: [{ role: Role.head_office }, { userStores: { some: { storeId } } }] }
          : {}),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Convenience: emit to whoever can act on `requiredRole` at a store. */
  async emitToApprovers(
    storeId: string | null,
    requiredRole: Role,
    input: EmitInput,
    excludeUserId?: string,
    organisationId?: string | null,
  ): Promise<void> {
    const recipients = await this.recipientsFor(storeId, requiredRole, excludeUserId, organisationId);
    await this.emit(recipients, input);
  }

  // ==========================================================================
  // Feed + read/clear state
  // ==========================================================================

  /**
   * GET /notifications — the caller's own feed, newest first.
   *
   * Dismissed rows are excluded unless `includeDismissed` is set, so "clear" is
   * reversible from the history view rather than destroying the record.
   */
  async feed(user: AuthUser, query: FeedQueryDto = {}) {
    const take = Math.min(query.limit ?? 50, 200);
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      ...(query.includeDismissed ? {} : { dismissedAt: null }),
      ...(query.unreadOnly ? { readAt: null } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };

    const [rows, unreadCount, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take,
      }),
      this.prisma.notification.count({
        where: { userId: user.id, readAt: null, dismissedAt: null },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { unreadCount, total, items: rows.map((r) => this.toView(r)) };
  }

  private toView(r: any) {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      href: r.href,
      storeId: r.storeId,
      entityType: r.entityType,
      entityId: r.entityId,
      priority: r.priority,
      actorName: r.actorName,
      read: r.readAt != null,
      dismissed: r.dismissedAt != null,
      createdAt: r.createdAt.toISOString(),
      metadata: r.metadata ?? null,
    };
  }

  /** PATCH /notifications/:id/read — mark one read/unread (own rows only). */
  async markRead(user: AuthUser, id: string, read = true) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, userId: user.id },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    const row = await this.prisma.notification.update({
      where: { id },
      data: { readAt: read ? (existing.readAt ?? new Date()) : null },
    });
    return this.toView(row);
  }

  /** POST /notifications/read-all — mark every unread one read. */
  async markAllRead(user: AuthUser) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null, dismissedAt: null },
      data: { readAt: new Date() },
    });
    return { marked: count };
  }

  /**
   * DELETE /notifications/:id — clear one from the bell.
   *
   * A soft dismiss, not a delete: the row stays so the history view and the
   * assistant can still answer "what was I told about this order last week".
   */
  async dismiss(user: AuthUser, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, userId: user.id },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    const row = await this.prisma.notification.update({
      where: { id },
      data: { dismissedAt: new Date(), readAt: existing.readAt ?? new Date() },
    });
    return this.toView(row);
  }

  /**
   * DELETE /notifications — clear all.
   *
   * `onlyRead` clears just the ones already seen, which is the safer default for
   * a "Clear all" button: it cannot bury something the user never looked at.
   */
  async dismissAll(user: AuthUser, onlyRead = false) {
    const now = new Date();
    const { count } = await this.prisma.notification.updateMany({
      where: {
        userId: user.id,
        dismissedAt: null,
        ...(onlyRead ? { readAt: { not: null } } : {}),
      },
      data: { dismissedAt: now, readAt: now },
    });
    return { cleared: count };
  }

  // ==========================================================================
  // Live stream
  // ==========================================================================

  /** The caller's push stream, consumed by the SSE endpoint. */
  stream(userId: string) {
    return this.bus.subscribe(userId);
  }

  // ==========================================================================
  // Actionable counts (the original derived summary — still the work queue)
  // ==========================================================================

  /**
   * GET /notifications/summary — role-aware, store-scoped actionable counts.
   *
   * Kept alongside the persisted feed and serving a different purpose: the feed
   * says what HAPPENED, this says what is still OPEN. Every count is recomputed
   * from the source tables on each call, so it cannot drift the way a cleared
   * notification can — clearing a notification must never hide live work.
   */
  async summary(user: AuthUser, headerStore?: string) {
    const storeWhere = this.scope.storeFilter(user, headerStore);
    const rank = ROLE_RANK[user.role];
    const items: NotificationItem[] = [];

    // --- Discount approvals (store_manager+; only requests the user can act on) ---
    if (rank >= ROLE_RANK.store_manager) {
      // Roles the user outranks-or-equals => may approve a request requiring them.
      const actable = (Object.keys(ROLE_RANK) as Role[]).filter(
        (r) => rank >= ROLE_RANK[r],
      );
      const discount = await this.prisma.discountRequest.count({
        where: {
          ...storeWhere,
          status: { in: ['pending', 'escalated'] },
          // Never count something the user cannot decide because they raised it
          // — self-approval is refused at the service layer.
          requestedById: { not: user.id },
          OR: [
            { requiredRole: { in: actable } },
            // Legacy rows without requiredRole fall back to requestedRole, then HO.
            { requiredRole: null, requestedRole: { in: actable } },
            ...(user.role === 'head_office'
              ? [{ requiredRole: null, requestedRole: null }]
              : []),
          ],
        },
      });
      if (discount > 0) {
        items.push({ type: 'discount', label: 'Discount approvals', count: discount, href: '/approvals' });
      }

      // --- Special requests raised by branches (store_manager+) ---
      const special = await this.prisma.specialRequest.count({
        where: {
          ...storeWhere,
          status: { in: ['pending', 'escalated'] },
          requiredRole: { in: actable },
          requestedById: { not: user.id },
        },
      });
      if (special > 0) {
        items.push({
          type: 'special_request',
          label: 'Branch requests',
          count: special,
          href: '/requests',
        });
      }
    }

    // --- Return approvals (head_office only) ---
    if (user.role === 'head_office') {
      const ret = await this.prisma.returnRecord.count({
        where: { ...storeWhere, status: 'pending_approval' },
      });
      if (ret > 0) {
        items.push({ type: 'return', label: 'Return approvals', count: ret, href: '/approvals' });
      }
    }

    // --- Leave requests (store_manager+) ---
    if (rank >= ROLE_RANK.store_manager) {
      const leave = await this.prisma.leaveRequest.count({
        where: { ...storeWhere, status: 'pending', staffId: { not: user.id } },
      });
      if (leave > 0) {
        items.push({ type: 'leave', label: 'Leave requests', count: leave, href: '/approvals' });
      }
    }

    // --- Follow-ups due (everyone, incl. salesperson) ---
    const reminder = await this.prisma.leadFollowUp.count({
      where: { ...storeWhere, done: false, dueDate: { lte: endOfTodayUtc() } },
    });
    if (reminder > 0) {
      items.push({ type: 'reminder', label: 'Follow-ups due', count: reminder, href: '/reminders' });
    }

    // --- Branches awaiting setup (area_manager+; auto-detected pending stores) ---
    if (rank >= ROLE_RANK.store_manager) {
      const pending = await this.prisma.store.count({
        where: {
          status: 'pending',
          isAggregate: false,
          isHolding: false,
          // storeIds is organisation-bounded for every role (head_office
          // included), so this is the tenant boundary — never an unfiltered {}
          // that would count another organisation's pending branches.
          id: { in: user.storeIds },
        },
      });
      if (pending > 0) {
        items.push({
          type: 'store_pending',
          label: 'Branches to review',
          count: pending,
          href: '/settings/stores',
        });
      }
    }

    // --- Branches that have not filed today's daily report (store_manager+) ---
    // Counted per store's OWN date: a branch is not late because the server is
    // in a different timezone. Bounded to the caller's store scope, which is
    // organisation-bounded — never a cross-tenant count.
    if (rank >= ROLE_RANK.store_manager) {
      const stores = await this.prisma.store.findMany({
        where: {
          isAggregate: false,
          isActive: true,
          isHolding: false,
          attendanceOnly: false,
          id: { in: user.storeIds },
        },
        select: { id: true, timezone: true },
      });
      if (stores.length) {
        const now = new Date();
        const wanted = stores.map((s) => ({
          storeId: s.id,
          date: businessDate(now, resolveTz(s.timezone)),
        }));
        const filed = await this.prisma.dailyReport.findMany({
          where: { OR: wanted.map((w) => ({ storeId: w.storeId, reportDate: w.date })) },
          select: { storeId: true },
        });
        const filedIds = new Set(filed.map((f) => f.storeId));
        const missing = wanted.length - filedIds.size;
        if (missing > 0) {
          items.push({
            type: 'dsr_missing',
            label:
              missing === 1
                ? 'Branch has not reported today'
                : 'Branches have not reported today',
            count: missing,
            href: '/reporting',
          });
        }
      }
    }

    const total = items.reduce((sum, i) => sum + i.count, 0);
    const unreadCount = await this.prisma.notification.count({
      where: { userId: user.id, readAt: null, dismissedAt: null },
    });
    return { total, items, unreadCount };
  }
}
