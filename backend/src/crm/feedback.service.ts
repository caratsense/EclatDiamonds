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
import { readableParty } from '../common/sales-scope';
import { StoreScopeService } from '../common/store-scope.service';
import { businessDate, instantFromLocalTime, parseHHMM, resolveTz } from '../common/tz.util';
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
 * One of the two requests that go out after a visit.
 *
 * The client asked for this in hours — "one just after a day a customer visits
 * ... and second would go after 48 hours" — so hours is the stored unit. The
 * send is still pinned to the branch's own time of day: 48 hours after a visit
 * that ended at 23:30 is 23:30, and a jeweller does not message a customer in
 * the middle of the night.
 */
export interface AfterVisitStep {
  /** 1 = the request itself, 2 = the later one. The order is the meaning. */
  step: 1 | 2;
  enabled: boolean;
  /**
   * Hours after the visit ended, never under a day — see MIN_DELAY_HOURS.
   *
   * It chooses the local DAY, not the minute: whole days are counted from the
   * visit's own local day and `sendTimeLocal` then decides the hour, so 24 and
   * 30 hours both land on the day after the visit. That is the rule the single
   * request has always been scheduled by, and changing it would move every
   * already-configured tenant's send.
   */
  delayHours: number;
  /** Local "HH:MM" at the branch, on the day the delay lands on. */
  sendTimeLocal: string;
  /** A provider-approved utility template taking {{1}} first name, {{2}} link. */
  templateName: string | null;
  templateLanguage: string | null;
}

/**
 * The automatic ask after a walk-in. OFF unless a tenant turns it on: one
 * business asked for "a week later", which is a policy for that business, not a
 * default to impose on every tenant.
 */
export interface AfterVisitPolicy {
  enabled: boolean;
  /*
   * Step one, flattened, in exactly the keys this policy has always been stored
   * and read under. Kept rather than replaced because an organisation that
   * configured one request before this change must keep behaving identically
   * after it, and because the walk-in scheduler reads these. `steps[0]` is the
   * same four facts, read as a step.
   */
  /** Whole local days after the visit — `Math.floor(steps[0].delayHours / 24)`. */
  delayDays: number;
  /** Local "HH:MM" on that day. */
  sendTimeLocal: string;
  templateName: string | null;
  templateLanguage: string | null;
  /** The request, then the later one. Always two entries, each with its own switch. */
  steps: [AfterVisitStep, AfterVisitStep];
}

/** The stored key step two lives under. Absent until a tenant adds one. */
const SECOND_STEP_KEY = 'second';

const HOURS_PER_DAY = 24;
const DAY_MS = 86_400_000;

/**
 * A step never goes out less than a day after the visit.
 *
 * Not an arbitrary floor. The due day is whole local days after the visit's own
 * local day, which is how the single request has always been scheduled; a delay
 * under a day would resolve to the day of the visit itself here while the
 * `delayDays` the walk-in scheduler reads would still say the day after — one
 * setting, two different days. A day is also the soonest the client asked for.
 */
export const MIN_DELAY_HOURS = HOURS_PER_DAY;
/** 60 days, the bound the single request already had, expressed in hours. */
export const MAX_DELAY_HOURS = 60 * HOURS_PER_DAY;

const STEP_ONE_DEFAULTS: AfterVisitStep = {
  step: 1,
  enabled: false,
  /** "One just after a day a customer visits" — the client's own first step. */
  delayHours: 24,
  sendTimeLocal: '11:00',
  templateName: null,
  templateLanguage: null,
};

const STEP_TWO_DEFAULTS: AfterVisitStep = {
  step: 2,
  enabled: false,
  /** "And second would go after 48 hours". */
  delayHours: 48,
  sendTimeLocal: '11:00',
  templateName: null,
  templateLanguage: null,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Requests that were actually PUT to somebody. An automatic ask that is still
 * waiting for its day, or was cancelled before it came due, asked nobody
 * anything and must not dilute a response rate.
 */
export const ASKED_FEEDBACK: Prisma.FeedbackRequestWhereInput = {
  status: { notIn: ['scheduled', 'processing'] },
  NOT: { origin: 'visit_auto', status: 'cancelled', messageId: null, taskId: null },
};

/**
 * One step out of whatever is stored, falling back field by field.
 *
 * `delayHours` wins when present. `delayDays` is what every organisation that
 * configured this before the second step existed has stored, so it is still
 * read — and still written alongside the hours, so nothing that reads the old
 * key sees a different schedule than this does.
 */
function readStep(step: 1 | 2, raw: Record<string, unknown>, fallback: AfterVisitStep): AfterVisitStep {
  const hours = Number(raw.delayHours);
  const days = Number(raw.delayDays);
  const delayHours =
    Number.isInteger(hours) && hours >= MIN_DELAY_HOURS && hours <= MAX_DELAY_HOURS
      ? hours
      : Number.isInteger(days) && days >= 1 && days <= MAX_DELAY_HOURS / HOURS_PER_DAY
        ? days * HOURS_PER_DAY
        : fallback.delayHours;
  return {
    step,
    enabled: raw.enabled === true,
    delayHours,
    sendTimeLocal:
      typeof raw.sendTimeLocal === 'string' && HHMM.test(raw.sendTimeLocal)
        ? raw.sendTimeLocal
        : fallback.sendTimeLocal,
    templateName: typeof raw.templateName === 'string' && raw.templateName ? raw.templateName : null,
    templateLanguage:
      typeof raw.templateLanguage === 'string' && raw.templateLanguage ? raw.templateLanguage : null,
  };
}

export function readAfterVisit(value: unknown): AfterVisitPolicy {
  return readPolicy(value, [STEP_ONE_DEFAULTS, STEP_TWO_DEFAULTS]);
}

/**
 * The same read, against chosen fallbacks.
 *
 * A save falls back to what the organisation already has rather than to the
 * product defaults: a delay the DTO somehow let through out of range must leave
 * a configured request where it was, not quietly reset it to 24 hours.
 */
function readPolicy(
  value: unknown,
  fallbacks: [AfterVisitStep, AfterVisitStep],
): AfterVisitPolicy {
  const raw = jsonObject(value);
  const enabled = raw.enabled === true;
  /*
   * Step one has no `enabled` of its own: the policy switch IS step one's
   * switch, and that is not a shortcut. There is no such thing as "send only
   * the chaser" — the second request follows up on the first, so it cannot be
   * the only one to go out.
   */
  const first = readStep(1, { ...raw, enabled }, fallbacks[0]);
  const second = readStep(2, jsonObject(raw[SECOND_STEP_KEY]), fallbacks[1]);
  return {
    enabled,
    delayDays: Math.floor(first.delayHours / HOURS_PER_DAY),
    sendTimeLocal: first.sendTimeLocal,
    templateName: first.templateName,
    templateLanguage: first.templateLanguage,
    steps: [first, second],
  };
}

/** The same policy with everything switched off, down to each step's own switch. */
function offPolicy(policy: AfterVisitPolicy): AfterVisitPolicy {
  return {
    ...policy,
    enabled: false,
    steps: [
      { ...policy.steps[0], enabled: false },
      { ...policy.steps[1], enabled: false },
    ],
  };
}

/** Back to the stored shape: step one flat under the legacy keys, step two nested. */
function writeAfterVisit(policy: AfterVisitPolicy): Record<string, unknown> {
  const [first, second] = policy.steps;
  return {
    enabled: policy.enabled,
    // Both units, kept in step. `delayDays` is still the key the walk-in
    // scheduler reads, and MIN_DELAY_HOURS is what guarantees the two agree.
    delayDays: Math.floor(first.delayHours / HOURS_PER_DAY),
    delayHours: first.delayHours,
    sendTimeLocal: first.sendTimeLocal,
    templateName: first.templateName,
    templateLanguage: first.templateLanguage,
    [SECOND_STEP_KEY]: {
      enabled: second.enabled,
      delayHours: second.delayHours,
      sendTimeLocal: second.sendTimeLocal,
      templateName: second.templateName,
      templateLanguage: second.templateLanguage,
    },
  };
}

/** Everything a caller may send. The flat step-one fields are still accepted. */
export type AfterVisitPolicyInput = Partial<Omit<AfterVisitPolicy, 'steps'>> & {
  steps?: Array<Partial<AfterVisitStep> | undefined>;
};

/** Drop only the keys that were not sent. `null` is an instruction: clear it. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * The current policy plus whatever was sent.
 *
 * Only the fields actually sent are applied: a validated DTO carries the rest
 * as `undefined`, and spreading those would switch the policy off. `null` is
 * not that — it means clear this template.
 *
 * The flat step-one fields are still honoured, because the settings screen sent
 * them for months before a second step existed and a PATCH written against the
 * old shape must keep working. `steps[0]` wins when both arrive: a caller that
 * sends the new shape meant it.
 */
export function mergeAfterVisit(
  current: AfterVisitPolicy,
  input: AfterVisitPolicyInput,
): AfterVisitPolicy {
  const flat = defined({
    delayHours: input.delayDays === undefined ? undefined : input.delayDays * HOURS_PER_DAY,
    sendTimeLocal: input.sendTimeLocal,
    templateName: input.templateName,
    templateLanguage: input.templateLanguage,
  });
  const enabled = input.enabled ?? input.steps?.[0]?.enabled ?? current.enabled;
  const first: AfterVisitStep = {
    ...current.steps[0],
    ...flat,
    ...defined(input.steps?.[0] ?? {}),
    step: 1,
    enabled,
  };
  const second: AfterVisitStep = {
    ...current.steps[1],
    ...defined(input.steps?.[1] ?? {}),
    step: 2,
  };
  /*
   * Round-tripped through the stored shape on purpose: every bound — the delay
   * floor, the "HH:MM" shape, an empty template name meaning none — is then
   * enforced by the same code that enforces it on the way out of the database,
   * so a saved policy and a loaded one cannot disagree.
   */
  return readPolicy(
    writeAfterVisit({ ...current, enabled, steps: [first, second] }),
    current.steps,
  );
}

/** The policy in one line, for the audit trail. Product words, not column names. */
export function describeAfterVisit(policy: AfterVisitPolicy): string {
  if (!policy.enabled) return 'off';
  const [first, second] = policy.steps;
  const when = (s: AfterVisitStep) => `${s.delayHours}h later at ${s.sendTimeLocal}`;
  return `on, ${when(first)}${second.enabled ? `, then again ${when(second)}` : ', no second request'}`;
}

/**
 * When a step goes out, for a visit that closed at `closedAt`.
 *
 * Whole local days after the visit's own local day, at the branch's send time —
 * the rule the single request has always used, so a tenant configured before
 * this change gets the same instant after it. A customer who left at 23:30 on
 * the 1st in Kolkata is asked on the 2nd, not on the 1st because the server
 * runs in UTC.
 */
export function afterVisitStepDueAt(
  closedAt: Date,
  timezone: string | null | undefined,
  step: AfterVisitStep,
): Date {
  const tz = resolveTz(timezone);
  const days = Math.floor(step.delayHours / HOURS_PER_DAY);
  const day = new Date(businessDate(closedAt, tz).getTime() + days * DAY_MS);
  return instantFromLocalTime(day, parseHHMM(step.sendTimeLocal), tz);
}

/**
 * Minutes from the visit's local midnight to when a step goes out.
 *
 * Exported because the gap BETWEEN the two requests has to be measured in the
 * same units the ordering guard uses. `delayHours` alone chooses only the local
 * day, so a 24h/18:00 then 48h/09:00 pair reads as 24 hours apart in hours and
 * is really 15 — and the chaser landed closer to the first ask than arranged.
 */
export function stepOffsetMinutes(step: AfterVisitStep): number {
  return (
    Math.floor(step.delayHours / HOURS_PER_DAY) * HOURS_PER_DAY * 60 + parseHHMM(step.sendTimeLocal)
  );
}

/**
 * Does the second request actually land after the first?
 *
 * Compared as offsets rather than hours because the delay chooses the day and
 * `sendTimeLocal` the hour: 30 hours at 09:00 lands BEFORE 24 hours at 11:00,
 * since both fall on the day after the visit and the clock then decides. A
 * chaser that arrives before the thing it chases is the one arrangement no
 * tenant means, and it is easy to produce by accident.
 */
export function afterVisitStepsAreOrdered(steps: [AfterVisitStep, AfterVisitStep]): boolean {
  if (!steps[1].enabled) return true;
  return stepOffsetMinutes(steps[1]) > stepOffsetMinutes(steps[0]);
}

/**
 * The second request, when there is one to send.
 *
 * Null when the whole automation is off, when the step is off, or when it has
 * no template. The second request deliberately has NO staff-task fallback: the
 * first one already raises a task when WhatsApp cannot carry it, and two tasks
 * about one visit is work nobody asked for.
 */
export function secondAskStep(policy: AfterVisitPolicy): AfterVisitStep | null {
  const step = policy.steps[1];
  if (!policy.enabled || !step.enabled || !step.templateName) return null;
  return step;
}

/** Why the second request did or did not go out. */
export type SecondAskOutcome =
  | 'send'
  | 'not_configured'
  | 'not_due'
  | 'already_sent'
  | 'already_answered'
  | 'already_replied'
  | 'first_never_arrived'
  | 'not_contactable';

/** The same outcomes in words a manager can act on. Product words, not column names. */
export const SECOND_ASK_REASONS: Record<SecondAskOutcome, string> = {
  send: 'Due now.',
  not_configured: 'No second feedback request is set up.',
  not_due: 'The second request is not due yet.',
  already_sent: 'The second request has already gone out.',
  already_answered: 'They had already answered.',
  already_replied: 'They had already written back, so a person is talking to them.',
  first_never_arrived: 'The first request never reached them.',
  not_contactable: 'They asked not to be contacted.',
};

/** Everything the decision below is allowed to depend on. */
export interface SecondAskFacts {
  /** A second step exists, is on, and has a template — `secondAskStep` decides this. */
  configured: boolean;
  /** The request's own status, as FeedbackRequest stores it. */
  status?: string | null;
  /** Stamped by the outbox when the FIRST request actually left. */
  sentAt?: Date | null;
  reminderDueAt?: Date | null;
  reminderSentAt?: Date | null;
  /** The customer wrote back on WhatsApp. NOT a form submission. */
  repliedAt?: Date | null;
  respondedAt?: Date | null;
  rating?: number | null;
  /** True when an NpsResponse row is matched to this request. */
  hasMatchedResponse?: boolean;
  /** Set when the first request was handed to a colleague instead of WhatsApp. */
  handedToStaffTaskId?: string | null;
  /** False when they said STOP, or the customer record was archived. */
  contactable: boolean;
}

/**
 * WHETHER THE SECOND REQUEST GOES OUT.
 *
 * The default is not to send. A second nag to somebody who already answered is
 * worse than no second message at all: the first one was a courtesy, the second
 * one tells them nobody read what they wrote.
 *
 * Highest precedence first, and every one of these is a deliberate stop:
 *
 *  1. already_sent — the only guard about us rather than them. The sweep claims
 *     the row conditionally as well; this is belt and braces.
 *  2. already_answered — they filled the form, or a rating is on the row. The
 *     request is finished, whatever the clock says.
 *  3. already_replied — they wrote back on WhatsApp WITHOUT filling the form.
 *     This codebase keeps those two facts apart on purpose (see nps-stage.ts)
 *     and so does this: a reply means a colleague is in a conversation with
 *     this customer, and a scheduled chaser landing in the middle of it is the
 *     software talking over a person.
 *  4. first_never_arrived — the first request was cancelled, was handed to a
 *     colleague to make by phone, or has simply not gone yet. A message reading
 *     "following up on my earlier message" when there was no earlier message is
 *     worse than silence; worse still, it would be the FIRST WhatsApp this
 *     customer got, sent at the second step's delay on the second step's
 *     template, which is not what anybody configured.
 *  5. not_contactable — the outbox refuses this too, but stopping here means
 *     the row is never even claimed.
 *  6. not_due — simply early.
 */
export function secondAskOutcome(facts: SecondAskFacts, now: Date = new Date()): SecondAskOutcome {
  if (!facts.configured) return 'not_configured';
  if (facts.reminderSentAt) return 'already_sent';
  if (
    facts.respondedAt ||
    // Not `!== null`: the field is optional, and an absent rating must not read
    // as an answer.
    typeof facts.rating === 'number' ||
    facts.hasMatchedResponse ||
    facts.status === 'responded'
  ) {
    return 'already_answered';
  }
  if (facts.repliedAt) return 'already_replied';
  const firstArrived =
    Boolean(facts.sentAt) &&
    !facts.handedToStaffTaskId &&
    facts.status !== 'cancelled' &&
    facts.status !== 'expired';
  if (!firstArrived) return 'first_never_arrived';
  if (!facts.contactable) return 'not_contactable';
  if (!facts.reminderDueAt || facts.reminderDueAt > now) return 'not_due';
  return 'send';
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
    // Collection switched off switches the automatic ask off with it — both
    // steps, since each step's switch only says whether it would go at all.
    if (s[SETTINGS.enabled] === false) return offPolicy(readAfterVisit(s[SETTINGS.afterVisit]));
    return readAfterVisit(s[SETTINGS.afterVisit]);
  }

  async updateSettings(
    user: AuthUser,
    input: {
      enabled?: boolean;
      positiveThreshold?: number;
      escalateAtOrBelow?: number;
      reviewLinks?: Record<string, string>;
      afterVisit?: AfterVisitPolicyInput;
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
      // Do not make an unrelated settings edit fail because an old link belongs
      // to a branch that has since closed. Newly submitted branch links, however,
      // must point at a branch that can actually serve customers.
      if (input.reviewLinks && Object.hasOwn(input.reviewLinks, storeId)) {
        await this.scope.assertTradingStore(storeId);
      }
      if (!/^https:\/\//i.test(url)) {
        // http:// and anything else is refused: this URL is handed to a customer
        // and a non-https link is both a downgrade and a phishing shape.
        throw new BadRequestException('A review link must be an https:// address.');
      }
    }

    const afterVisit = mergeAfterVisit(current.afterVisit, input.afterVisit ?? {});
    if (!afterVisitStepsAreOrdered(afterVisit.steps)) {
      // A chaser that arrives before the request it chases is the one
      // arrangement no tenant means, and it is easy to produce by accident:
      // 24 hours at 18:00 lands after 48 hours at 09:00.
      throw new BadRequestException(
        'The second feedback request must go out after the first one.',
      );
    }
    // Enabling without a template is allowed: each ask then becomes a task for
    // the person who served the customer, and says why.
    // Under the settings row lock: several unrelated features share this column.
    await updateOrgSettings(this.prisma, user.organisationId, (s) => ({
      ...s,
      [SETTINGS.enabled]: input.enabled ?? current.enabled,
      [SETTINGS.positiveThreshold]: positive,
      [SETTINGS.escalateAtOrBelow]: escalate,
      [SETTINGS.reviewLinkByStore]: links,
      // Written in the stored shape, not as the read shape: `steps` is derived
      // from the keys below, and storing both would leave two answers to "when
      // does the first request go out" with nothing to say which one wins.
      [SETTINGS.afterVisit]: writeAfterVisit(afterVisit),
    }));

    await this.audit.record(user, {
      action: 'feedback.settings_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Feedback settings updated — happy at ${positive}+, escalate at ${escalate} or below; after-visit ask ${describeAfterVisit(afterVisit)}.`,
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
      where: { id: input.partyId, ...readableParty(user) },
      select: { id: true, name: true, storeId: true },
    });
    if (!party) throw new NotFoundException('That customer does not exist.');

    const storeId =
      input.storeId ?? (user.storeIds.length === 1 ? user.storeIds[0] : party.storeId ?? null);
    if (storeId) {
      this.scope.assertStoreAllowed(user, storeId);
      await this.scope.assertTradingStore(storeId);
    }

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

    const respondedAt = new Date();
    await this.prisma.feedbackRequest.update({
      where: { id: row.id },
      data: {
        status: 'responded',
        rating,
        comment: input.comment?.slice(0, 2000) ?? null,
        respondedAt,
        escalatedTaskId,
        reviewLinkOffered: Boolean(reviewLink),
      },
    });

    /*
     * The walk-in register's "NPS response received" column, beside the "sent"
     * one the outbox stamps. Both exist because head office reconciles the
     * register against their own sheet row by row, and a column they can only
     * get by joining to FeedbackRequest is one they cannot check.
     */
    if (row.checkInId) {
      await this.prisma.checkIn.updateMany({
        where: { id: row.checkInId, npsResponseReceivedAt: null },
        data: { npsResponseReceivedAt: respondedAt },
      });
    }

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
