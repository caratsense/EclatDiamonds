import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';

/**
 * ActivityService — the one place anything is written to the customer timeline
 * (Phase A3).
 *
 * DESIGN DECISION: recording an activity NEVER fails the business operation that
 * caused it. A sale that completed must not be rolled back because its timeline
 * row hit a unique-key collision. So `record()` swallows and logs its errors, and
 * the timeline is explicitly a best-effort PROJECTION, not a source of truth —
 * every event here is reconstructible from the module that owns the underlying
 * record.
 *
 * The one thing it must never do is lie: a swallowed failure is logged at error
 * level with the event that was lost, so a systematically broken writer shows up
 * in the logs rather than as a quietly thinning timeline.
 */

export interface ActivityInput {
  organisationId: string;
  type: string;
  summary: string;
  partyId?: string | null;
  leadId?: string | null;
  storeId?: string | null;
  actorUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  channel?: string | null;
  sourceSystem?: string | null;
  /** Stable natural key; a repeat of the same key is skipped, not duplicated. */
  dedupeKey?: string | null;
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class ActivityService {
  private readonly log = new Logger(ActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * Write one timeline event. Safe to call from inside any service; it never
   * throws.
   *
   * Pass `tx` to enlist in a caller's transaction when the event genuinely must
   * live or die with the record it describes (an import batch, say). Note the
   * trade-off: inside a transaction a duplicate `dedupeKey` will abort the
   * caller's transaction, so only do that when the caller's key is known unique.
   */
  async record(
    input: ActivityInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const client = tx ?? this.prisma;
    try {
      return await client.activityEvent.create({
        data: {
          organisationId: input.organisationId,
          type: input.type,
          summary: input.summary,
          partyId: input.partyId ?? null,
          leadId: input.leadId ?? null,
          storeId: input.storeId ?? null,
          actorUserId: input.actorUserId ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          channel: input.channel ?? null,
          sourceSystem: input.sourceSystem ?? null,
          dedupeKey: input.dedupeKey ?? null,
          occurredAt: input.occurredAt ?? new Date(),
          metadata: input.metadata,
        },
        select: { id: true },
      });
    } catch (e) {
      // A unique violation on dedupeKey is the SUCCESS case for a replay: the
      // event is already on the timeline. It is not worth an error log.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return null;
      }
      if (tx) throw e; // inside a caller's transaction, let them decide.
      this.log.error(
        `Timeline event dropped (${input.type} for org ${input.organisationId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  /** Convenience wrapper that fills organisation/actor from the caller. */
  async recordFor(
    user: AuthUser,
    input: Omit<ActivityInput, 'organisationId' | 'actorUserId'>,
  ): Promise<{ id: string } | null> {
    return this.record({ ...input, organisationId: user.organisationId, actorUserId: user.id });
  }

  /**
   * A customer's timeline, newest first.
   *
   * Store-scoped as well as org-scoped: a salesperson at one branch does not get
   * to read what a customer did at another branch just by knowing their id.
   * Events with no store (organisation-level: an email, an AI qualification) are
   * included, because excluding them would silently hide half a customer's
   * history from everyone but head office.
   */
  async timelineForParty(
    user: AuthUser,
    partyId: string,
    opts: { limit?: number; cursor?: string; types?: string[] } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const storeScope = this.scope.storeFilter(user);

    const where: Prisma.ActivityEventWhereInput = {
      organisationId: user.organisationId,
      partyId,
      ...(opts.types?.length ? { type: { in: opts.types } } : {}),
      OR: [storeScope, { storeId: null }],
    };

    const rows = await this.prisma.activityEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        actorUser: { select: { id: true, name: true, role: true } },
        store: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > take;
    return {
      events: hasMore ? rows.slice(0, take) : rows,
      nextCursor: hasMore ? rows[take - 1].id : null,
    };
  }

  /** The organisation-wide activity feed, for a dashboard "what's happening". */
  async feed(
    user: AuthUser,
    opts: { limit?: number; types?: string[]; storeId?: string; since?: Date } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const storeScope = this.scope.storeFilter(user, opts.storeId);
    return this.prisma.activityEvent.findMany({
      where: {
        organisationId: user.organisationId,
        ...(opts.types?.length ? { type: { in: opts.types } } : {}),
        ...(opts.since ? { occurredAt: { gte: opts.since } } : {}),
        OR: [storeScope, { storeId: null }],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      include: {
        actorUser: { select: { id: true, name: true } },
        party: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
      },
    });
  }
}
