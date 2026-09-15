import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from './activity.service';
import { updateOrgSettings } from '../config/org-settings';

/**
 * Customer feedback.
 *
 * The rule the whole module exists to keep: ONE question is asked, and what
 * happens next depends on the answer. A happy customer may be offered the
 * tenant's own public review link; an unhappy one is routed to a human and is
 * never shown that link.
 *
 * Two things follow from that and are worth stating because they are easy to
 * get backwards:
 *
 *   - The threshold is the TENANT'S, stored in settings, not a constant here.
 *     A clinic and a jeweller do not agree on what 4 out of 5 means.
 *   - `reviewLinkOffered` is persisted rather than derived. A boolean recomputed
 *     from today's threshold would rewrite history every time the threshold
 *     moved, and the one question a tenant may have to answer later is "did you
 *     ever invite an unhappy customer to review you publicly".
 */

/** Settings keys, named once. */
const SETTINGS = {
  reviewLinkByStore: 'feedbackReviewLinks',
  positiveThreshold: 'feedbackPositiveThreshold',
  escalateAtOrBelow: 'feedbackEscalateAtOrBelow',
  enabled: 'feedbackEnabled',
  afterVisit: 'feedbackAfterVisit',
} as const;

/**
 * The automatic ask after a walk-in. OFF unless a tenant turns it on: one
 * business asked for "a week later", which is a policy for that business, not a
 * default to impose on every tenant.
 */
export interface AfterVisitPolicy {
  enabled: boolean;
  /** Local days after the visit ended. */
  delayDays: number;
  /** Local "HH:MM" on that day. */
  sendTimeLocal: string;
  /** A provider-approved utility template taking {{1}} first name, {{2}} link. */
  templateName: string | null;
  templateLanguage: string | null;
}

const AFTER_VISIT_DEFAULTS: AfterVisitPolicy = {
  enabled: false,
  delayDays: 7,
  sendTimeLocal: '11:00',
  templateName: null,
  templateLanguage: null,
};

/**
 * Requests that were actually PUT to somebody. An automatic ask that is still
 * waiting for its day, or was cancelled before it came due, asked nobody
 * anything and must not dilute a response rate.
 */
export const ASKED_FEEDBACK: Prisma.FeedbackRequestWhereInput = {
  status: { notIn: ['scheduled', 'processing'] },
  NOT: { origin: 'visit_auto', status: 'cancelled', messageId: null, taskId: null },
};

function readAfterVisit(value: unknown): AfterVisitPolicy {
  const raw = jsonObject(value);
  const days = Number(raw.delayDays);
  return {
    enabled: raw.enabled === true,
    delayDays: Number.isInteger(days) && days >= 1 && days <= 60 ? days : AFTER_VISIT_DEFAULTS.delayDays,
    sendTimeLocal:
      typeof raw.sendTimeLocal === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.sendTimeLocal)
        ? raw.sendTimeLocal
        : AFTER_VISIT_DEFAULTS.sendTimeLocal,
    templateName: typeof raw.templateName === 'string' && raw.templateName ? raw.templateName : null,
    templateLanguage:
      typeof raw.templateLanguage === 'string' && raw.templateLanguage ? raw.templateLanguage : null,
  };
}

const DEFAULT_POSITIVE = 4;
const DEFAULT_ESCALATE = 2;

/** A response link is not useful forever, and an open one is an open door. */
const DEFAULT_EXPIRY_DAYS = 30;

const MANAGER_ROLES: Role[] = ['store_manager', 'area_manager', 'head_office'];

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  // =============================================================== settings

  async settings(user: AuthUser) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { settings: true },
    });
    const s = jsonObject(org?.settings);
    const links = jsonObject(s[SETTINGS.reviewLinkByStore]);
    return {
      enabled: s[SETTINGS.enabled] !== false,
      positiveThreshold: Number(s[SETTINGS.positiveThreshold] ?? DEFAULT_POSITIVE),
      escalateAtOrBelow: Number(s[SETTINGS.escalateAtOrBelow] ?? DEFAULT_ESCALATE),
      /**
       * One review link per branch, because a Google Business Profile is
       * per-location. A single organisation-wide link would send a customer who
       * visited Nashik to review the Pune branch.
       */
      reviewLinks: links as Record<string, string>,
      afterVisit: readAfterVisit(s[SETTINGS.afterVisit]),
    };
  }

  /** The after-visit policy for a tenant, for automation that has no signed-in user. */
  async afterVisitPolicy(organisationId: string): Promise<AfterVisitPolicy> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const s = jsonObject(org?.settings);
    // Collection switched off switches the automatic ask off with it.
    if (s[SETTINGS.enabled] === false) return { ...readAfterVisit(s[SETTINGS.afterVisit]), enabled: false };
    return readAfterVisit(s[SETTINGS.afterVisit]);
  }

  async updateSettings(
    user: AuthUser,
    input: {
      enabled?: boolean;
      positiveThreshold?: number;
      escalateAtOrBelow?: number;
      reviewLinks?: Record<string, string>;
      afterVisit?: Partial<AfterVisitPolicy>;
    },
  ) {
    this.assertManager(user);
    const current = await this.settings(user);

    const positive = input.positiveThreshold ?? current.positiveThreshold;
    const escalate = input.escalateAtOrBelow ?? current.escalateAtOrBelow;
    if (positive < 1 || positive > 5 || escalate < 1 || escalate > 5) {
      throw new BadRequestException('Ratings run from 1 to 5.');
    }
    if (escalate >= positive) {
      // Overlapping bands would mean one rating is both "offer them the review
      // link" and "put a human on it", and whichever check ran first would win
      // silently.
      throw new BadRequestException(
        'The escalation rating must be below the rating that counts as happy.',
      );
    }

    const links = input.reviewLinks ?? current.reviewLinks;
    for (const [storeId, url] of Object.entries(links)) {
      this.scope.assertStoreAllowed(user, storeId);
      if (!/^https:\/\//i.test(url)) {
        // http:// and anything else is refused: this URL is handed to a customer
        // and a non-https link is both a downgrade and a phishing shape.
        throw new BadRequestException('A review link must be an https:// address.');
      }
    }

    // Only the fields that were sent: a validated DTO carries the rest as
    // `undefined`, and spreading those would switch the policy off.
    const sent = Object.fromEntries(
      Object.entries(input.afterVisit ?? {}).filter(([, v]) => v !== undefined),
    );
    const afterVisit = readAfterVisit({ ...current.afterVisit, ...sent });
    // Enabling without a template is allowed: each ask then becomes a task for
    // the person who served the customer, and says why.
    // Under the settings row lock: several unrelated features share this column.
    await updateOrgSettings(this.prisma, user.organisationId, (s) => ({
      ...s,
      [SETTINGS.enabled]: input.enabled ?? current.enabled,
      [SETTINGS.positiveThreshold]: positive,
      [SETTINGS.escalateAtOrBelow]: escalate,
      [SETTINGS.reviewLinkByStore]: links,
      [SETTINGS.afterVisit]: afterVisit,
    }));

    await this.audit.record(user, {
      action: 'feedback.settings_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Feedback settings updated — happy at ${positive}+, escalate at ${escalate} or below; after-visit ask ${afterVisit.enabled ? `on, ${afterVisit.delayDays} day(s) later at ${afterVisit.sendTimeLocal}` : 'off'}.`,
    });

    return this.settings(user);
  }

  // ================================================================ asking

  /**
   * Create a request for one customer.
   *
   * Deliberately does NOT send anything itself. Delivery goes through the same
   * outbox and consent path as every other outbound message; a feedback ask is
   * still a message to a customer and must not be the one exception that skips
   * the policy.
   */
  async request(
    user: AuthUser,
    input: {
      partyId: string;
      storeId?: string;
      checkInId?: string;
      saleId?: string;
      taskId?: string;
    },
  ) {
    const settings = await this.settings(user);
    if (!settings.enabled) {
      throw new ConflictException('Feedback collection is switched off for this organisation.');
    }

    const party = await this.prisma.party.findFirst({
      where: { id: input.partyId, organisationId: user.organisationId },
      select: { id: true, name: true, storeId: true },
    });
    if (!party) throw new NotFoundException('That customer does not exist.');

    const storeId =
      input.storeId ?? (user.storeIds.length === 1 ? user.storeIds[0] : party.storeId ?? null);
    if (storeId) this.scope.assertStoreAllowed(user, storeId);

    /*
     * One open ask at a time, per customer.
     *
     * A customer who bought three things in a week must not get three surveys.
     * Checked rather than enforced by a unique index because "open" is a state,
     * not a key, and a customer legitimately gets a second ask after the first
     * is answered or expires.
     */
    const open = await this.prisma.feedbackRequest.findFirst({
      where: {
        organisationId: user.organisationId,
        partyId: party.id,
        status: { in: ['pending', 'sent'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    });
    if (open) {
      throw new ConflictException('This customer already has an unanswered feedback request.');
    }

    const row = await this.prisma.feedbackRequest.create({
      data: {
        organisationId: user.organisationId,
        storeId,
        partyId: party.id,
        checkInId: input.checkInId ?? null,
        saleId: input.saleId ?? null,
        taskId: input.taskId ?? null,
        publicKey: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
        createdById: user.id,
      },
    });

    await this.audit.record(user, {
      action: 'feedback.requested',
      entityType: 'FeedbackRequest',
      entityId: row.id,
      storeId,
      summary: `Asked ${party.name} for feedback.`,
    });

    return {
      id: row.id,
      publicKey: row.publicKey,
      /** Where to send them. The tenant's own domain wraps this. */
      responsePath: `/feedback/${row.publicKey}`,
      expiresAt: row.expiresAt,
    };
  }

  // ============================================================== answering

  /**
   * What the anonymous response page is allowed to know.
   *
   * The tenant's name and nothing else — no branch, no customer name, no
   * internal id. Someone who guesses a key must learn nothing from it.
   */
  async publicView(publicKey: string) {
    const row = await this.loadPublic(publicKey);
    const org = await this.prisma.organisation.findUnique({
      where: { id: row.organisationId },
      select: { name: true },
    });
    return {
      businessName: org?.name ?? 'this business',
      alreadyAnswered: row.status === 'responded',
    };
  }

  /**
   * Record the answer, and route it.
   *
   * Everything that decides the routing — the thresholds, the review link — is
   * read from the tenant's settings HERE, at answer time, so a tenant that
   * changes its policy affects the next response rather than rewriting past ones.
   */
  async respond(publicKey: string, input: { rating: number; comment?: string }) {
    const row = await this.loadPublic(publicKey);
    if (row.status === 'responded') {
      throw new ConflictException('This feedback has already been given. Thank you.');
    }
    const rating = Math.round(input.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Choose a rating from 1 to 5.');
    }

    const org = await this.prisma.organisation.findUnique({
      where: { id: row.organisationId },
      select: { settings: true },
    });
    const s = jsonObject(org?.settings);
    const positive = Number(s[SETTINGS.positiveThreshold] ?? DEFAULT_POSITIVE);
    const escalate = Number(s[SETTINGS.escalateAtOrBelow] ?? DEFAULT_ESCALATE);
    const links = jsonObject(s[SETTINGS.reviewLinkByStore]) as Record<string, string>;

    const happy = rating >= positive;
    const reviewLink = happy && row.storeId ? (links[row.storeId] ?? null) : null;

    let escalatedTaskId: string | null = null;
    if (rating <= escalate) {
      // A bad rating that nobody has to answer is just a number in a report.
      const task = await this.prisma.task.create({
        data: {
          organisationId: row.organisationId,
          storeId: row.storeId,
          partyId: row.partyId,
          title: `Unhappy customer — rated ${rating}/5`,
          detail: input.comment?.slice(0, 2000) ?? null,
          priority: 'high',
          status: 'open',
          assignee: 'Unassigned',
          dueDate: new Date(),
        },
      });
      escalatedTaskId = task.id;
    }

    await this.prisma.feedbackRequest.update({
      where: { id: row.id },
      data: {
        status: 'responded',
        rating,
        comment: input.comment?.slice(0, 2000) ?? null,
        respondedAt: new Date(),
        escalatedTaskId,
        reviewLinkOffered: Boolean(reviewLink),
      },
    });

    if (row.partyId) {
      await this.activity.record({
        organisationId: row.organisationId,
        partyId: row.partyId,
        storeId: row.storeId ?? undefined,
        type: 'feedback.received',
        channel: 'web',
        summary: `Rated ${rating}/5${escalatedTaskId ? ' — escalated to a person' : ''}`,
        entityType: 'FeedbackRequest',
        entityId: row.id,
      });
    }

    return {
      accepted: true,
      /**
       * Only ever non-null for a happy customer whose branch has a link
       * configured. An unhappy customer is never shown it — that is the whole
       * boundary between an internal complaint and a public review.
       */
      reviewLink,
      escalated: Boolean(escalatedTaskId),
    };
  }

  private async loadPublic(publicKey: string) {
    const row = await this.prisma.feedbackRequest.findFirst({
      where: {
        publicKey,
        // A tenant that has been suspended stops collecting, and a cancelled or
        // expired request is indistinguishable from one that never existed.
        // Nor is one still waiting for its day: nobody has been sent that link.
        status: { notIn: ['cancelled', 'expired', 'scheduled', 'processing'] },
        organisation: { status: { in: ['active', 'onboarding'] } },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!row) throw new NotFoundException('This feedback link is no longer available.');
    return row;
  }

  // =============================================================== reading

  /** Branch scores, computed in the database. */
  async summary(user: AuthUser, opts: { storeId?: string; days?: number } = {}) {
    if (opts.storeId) this.scope.assertStoreAllowed(user, opts.storeId);
    const days = Math.min(Math.max(opts.days ?? 90, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const where: Prisma.FeedbackRequestWhereInput = {
      organisationId: user.organisationId,
      ...this.scope.storeFilter(user),
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      status: 'responded',
      respondedAt: { gte: since },
    };

    const [agg, byRating, escalatedOpen, asked] = await Promise.all([
      this.prisma.feedbackRequest.aggregate({
        where,
        _count: { _all: true },
        _avg: { rating: true },
      }),
      this.prisma.feedbackRequest.groupBy({
        by: ['rating'],
        where,
        _count: { _all: true },
      }),
      this.prisma.feedbackRequest.count({
        where: { ...where, escalatedTaskId: { not: null } },
      }),
      this.prisma.feedbackRequest.count({
        where: {
          organisationId: user.organisationId,
          ...this.scope.storeFilter(user),
          ...(opts.storeId ? { storeId: opts.storeId } : {}),
          createdAt: { gte: since },
          AND: [ASKED_FEEDBACK],
        },
      }),
    ]);

    const distribution: Record<string, number> = {};
    for (const r of byRating) {
      if (r.rating !== null) distribution[String(r.rating)] = r._count._all;
    }

    return {
      responses: agg._count._all,
      asked,
      // null, not 0, with no responses: an average of nothing is not zero, and
      // a branch showing "0.0 out of 5" because nobody answered is a libel.
      averageRating: agg._count._all ? Number(agg._avg.rating?.toFixed(2)) : null,
      responseRate: asked ? Number(((agg._count._all / asked) * 100).toFixed(1)) : null,
      distribution,
      escalated: escalatedOpen,
      windowDays: days,
    };
  }

  /** The responses themselves, newest first. */
  async list(
    user: AuthUser,
    opts: { storeId?: string; escalatedOnly?: boolean; limit?: number; cursor?: string } = {},
  ) {
    if (opts.storeId) this.scope.assertStoreAllowed(user, opts.storeId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const rows = await this.prisma.feedbackRequest.findMany({
      where: {
        organisationId: user.organisationId,
        ...this.scope.storeFilter(user),
        ...(opts.storeId ? { storeId: opts.storeId } : {}),
        status: 'responded',
        ...(opts.escalatedOnly ? { escalatedTaskId: { not: null } } : {}),
      },
      orderBy: { respondedAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        rating: true,
        comment: true,
        respondedAt: true,
        storeId: true,
        escalatedTaskId: true,
        reviewLinkOffered: true,
        party: { select: { id: true, name: true } },
      },
    });

    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        respondedAt: r.respondedAt,
        storeId: r.storeId,
        escalated: Boolean(r.escalatedTaskId),
        escalatedTaskId: r.escalatedTaskId,
        reviewLinkOffered: r.reviewLinkOffered,
        customer: r.party,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]?.id : null,
    };
  }

  private assertManager(user: AuthUser) {
    if (!MANAGER_ROLES.includes(user.role)) {
      throw new BadRequestException('Only a manager can change feedback settings.');
    }
  }
}
