import { ConfigService } from '@nestjs/config';

import { ChannelAdaptersService } from '../integrations/adapters/channel-adapters.service';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackService, readAfterVisit, type AfterVisitPolicy } from './feedback.service';
import { VisitFeedbackService } from './visit-feedback.service';

/**
 * The second, later feedback request — the one the client asked for: "there are
 * two templates that will go. One just after a day a customer visits ... and
 * second would go after 48 hours."
 *
 * The rules worth a test are the ones nobody would ever see fail. A chaser that
 * goes twice, or goes to somebody who already answered, produces no error and
 * no log anybody reads — only a customer who was nagged. So what is pinned here
 * is: it is claimed so two sweeps cannot both send it, it is keyed apart from
 * the first message in the outbox, it stops for every reason it should, and it
 * is never recorded as sent until the provider has taken it.
 *
 * The rows live in a small in-memory stand-in for Prisma rather than in
 * Postgres, like `leads/follow-up-completion.spec.ts`: every rule above is
 * about which rows the sweep writes and what it leaves on them, which is
 * exactly what this can show, in a second.
 */

const IST = 'Asia/Kolkata';
const AT = (iso: string) => new Date(iso);
/** Ten minutes past the hour the second request became due. */
const NOW = AT('2026-11-17T05:40:00Z');

/** An organisation with both requests configured, 24 hours and 48 hours. */
const BOTH_STEPS: AfterVisitPolicy = readAfterVisit({
  enabled: true,
  delayHours: 24,
  sendTimeLocal: '11:00',
  templateName: 'visit_feedback',
  templateLanguage: 'en',
  second: {
    enabled: true,
    delayHours: 48,
    sendTimeLocal: '11:00',
    templateName: 'visit_feedback_reminder',
    templateLanguage: 'en',
  },
});

/** Exactly what an organisation that configured one request has stored today. */
const ONE_STEP_ONLY: AfterVisitPolicy = readAfterVisit({
  enabled: true,
  delayDays: 7,
  sendTimeLocal: '11:00',
  templateName: 'visit_feedback',
  templateLanguage: 'en',
});

interface Row {
  id: string;
  organisationId: string;
  storeId: string | null;
  partyId: string | null;
  checkInId: string | null;
  publicKey: string;
  origin: string;
  status: string;
  messageId: string | null;
  taskId: string | null;
  sentAt: Date | null;
  respondedAt: Date | null;
  repliedAt: Date | null;
  rating: number | null;
  scheduledFor: Date | null;
  expiresAt: Date | null;
  deliveryNote: string | null;
  dispatchAttempts: number;
  reminderDueAt: Date | null;
  reminderSentAt: Date | null;
  reminderMessageId: string | null;
  party: { name: string; archivedAt: Date | null } | null;
  _count: { npsResponses: number };
}

/** A visit whose first request left yesterday and whose second is due now. */
function askRow(over: Partial<Row> = {}): Row {
  return {
    id: 'fb_priya',
    organisationId: 'org_nibhana',
    storeId: 'store_bandra',
    partyId: 'party_priya',
    checkInId: 'ci_priya',
    publicKey: 'key_priya',
    origin: 'visit_auto',
    status: 'sent',
    messageId: 'msg_first',
    taskId: null,
    sentAt: AT('2026-11-16T05:30:00Z'),
    respondedAt: null,
    repliedAt: null,
    rating: null,
    scheduledFor: AT('2026-11-16T05:30:00Z'),
    expiresAt: AT('2026-12-16T05:30:00Z'),
    deliveryNote: null,
    dispatchAttempts: 1,
    reminderDueAt: AT('2026-11-17T05:30:00Z'),
    reminderSentAt: null,
    reminderMessageId: null,
    party: { name: 'Priya Shah', archivedAt: null },
    _count: { npsResponses: 0 },
    ...over,
  };
}

/* -------------------------------------------------------- the stand-in */

type Where = Record<string, unknown>;

function matches(row: object, where: Where): boolean {
  const fields = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c));
    if (key === 'AND') return (cond as Where[]).every((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond as Where);
    const value = fields[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return (value as Date | null)?.getTime() === cond.getTime();
    if (cond && typeof cond === 'object') {
      return Object.entries(cond as Where).every(([op, operand]) => {
        const absent = value === null || value === undefined;
        switch (op) {
          case 'lte':
            return !absent && (value as number) <= (operand as number);
          case 'gt':
            return !absent && (value as number) > (operand as number);
          case 'in':
            return (operand as unknown[]).includes(value);
          case 'notIn':
            return !(operand as unknown[]).includes(value);
          case 'not':
            return operand === null ? !absent : value !== operand;
          default:
            throw new Error(`the stand-in does not support the filter "${op}"`);
        }
      });
    }
    return value === cond;
  });
}

function applyData(row: object, data: Record<string, unknown>) {
  const fields = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Where)) {
      fields[key] = ((fields[key] as number) ?? 0) + Number((value as Where).increment);
    } else {
      fields[key] = value;
    }
  }
}

interface MessageRow {
  id: string;
  status: string;
  sentAt: Date | null;
  error: string | null;
}

function harness(opts: {
  rows: Row[];
  policy?: AfterVisitPolicy;
  messages?: MessageRow[];
  queue?: () => { queued: true; messageId: string } | { queued: false; code: string; reason: string };
  live?: boolean;
}) {
  const rows = opts.rows;
  const messages = opts.messages ?? [];
  const queued: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];

  const prisma = {
    feedbackRequest: {
      findMany: async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)),
      findFirst: async ({ where }: { where: Where }) =>
        rows.find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: { where: Where }) =>
        rows.find((r) => matches(r, where)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: Where }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error('no such feedback request');
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const row of hit) applyData(row, data);
        return { count: hit.length };
      },
      update: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, where))!;
        applyData(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      },
    },
    message: {
      findMany: async ({ where }: { where: Where }) => messages.filter((m) => matches(m, where)),
    },
    checkIn: {
      findUnique: async () => ({
        // 23:30 IST on 15 November — the visit the requests are measured from.
        timeIn: AT('2026-11-15T12:00:00Z'),
        timeOut: AT('2026-11-15T18:00:00Z'),
        repId: 'rep_bandra',
        attendedById: 'rep_bandra',
        store: { timezone: IST },
      }),
    },
    task: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'task_1', ...data }) },
    user: { findFirst: async () => ({ id: 'rep_bandra', name: 'Rekha' }) },
  } as unknown as PrismaService;

  const service = new VisitFeedbackService(
    prisma,
    { afterVisitPolicy: async () => opts.policy ?? BOTH_STEPS } as unknown as FeedbackService,
    {
      queueCustomerNotice: async (input: Record<string, unknown>) => {
        queued.push(input);
        return opts.queue ? opts.queue() : { queued: true, messageId: `msg_${queued.length}` };
      },
    } as unknown as OmnichannelService,
    { get: () => 'https://app.nibhana.example' } as unknown as ConfigService,
    {
      deliverability: async () => ({
        state: opts.live === false ? 'dry_run' : 'live',
        reason: opts.live === false ? 'no sender is connected' : '',
      }),
    } as unknown as ChannelAdaptersService,
  );

  return { service, rows, queued, created };
}

/* ------------------------------------------------------------- the tests */

describe('the second request, when it is due and nothing has come back', () => {
  it('goes out on its own template, keyed apart from the first message', async () => {
    const { service, queued } = harness({ rows: [askRow()] });

    const outcome = await service.sweep(NOW);

    expect(outcome.secondQueued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0].templateName).toBe('visit_feedback_reminder');
    /*
     * The key MUST differ from the first message's `visit-feedback:<id>`. A
     * shared key hands back the FIRST message, and the sweep then records its
     * outcome as the second one's — the shape of the broadcast that reported
     * "125 of 126 sent" while nobody received anything.
     */
    expect(queued[0].idempotencyKey).toBe('visit-feedback-second:fb_priya');
    expect(queued[0].idempotencyKey).not.toBe('visit-feedback:fb_priya');
  });

  it('is not recorded as sent until the provider has taken it', async () => {
    const { service, rows } = harness({ rows: [askRow()] });

    await service.sweep(NOW);

    expect(rows[0].reminderMessageId).toBe('msg_1');
    // Queued is not sent. The client's register keeps those apart, and a row
    // that says a reminder went out when it is still in the outbox is the one
    // thing the register must never say.
    expect(rows[0].reminderSentAt).toBeNull();
    // And the plan is gone, so the next tick does not consider it again.
    expect(rows[0].reminderDueAt).toBeNull();
  });

  it('cannot be sent twice by two sweeps over the same row', async () => {
    const { service, queued } = harness({ rows: [askRow()] });

    const [a, b] = await Promise.all([service.sweep(NOW), service.sweep(NOW)]);

    expect(queued).toHaveLength(1);
    expect(a.secondQueued + b.secondQueued).toBe(1);
  });

  it('leaves the note explaining the FIRST request alone', async () => {
    // A manager reads `deliveryNote` and acts on it. Overwriting it with a note
    // about the chaser would lose the explanation.
    const { service, rows } = harness({
      rows: [askRow({ deliveryNote: 'WhatsApp was not live for this organisation: no sender.' })],
    });

    await service.sweep(NOW);

    expect(rows[0].deliveryNote).toBe(
      'WhatsApp was not live for this organisation: no sender.',
    );
  });
});

describe('the second request does not go out', () => {
  const stops = async (over: Partial<Row>, policy?: AfterVisitPolicy) => {
    const { service, rows, queued } = harness({ rows: [askRow(over)], policy });
    const outcome = await service.sweep(NOW);
    return { outcome, row: rows[0], queued };
  };

  it('to somebody who already answered the form', async () => {
    const { outcome, row, queued } = await stops({ respondedAt: AT('2026-11-16T09:00:00Z') });

    expect(queued).toHaveLength(0);
    expect(outcome.secondDropped).toBe(1);
    // Stopped for good, and never marked as sent.
    expect(row.reminderDueAt).toBeNull();
    expect(row.reminderSentAt).toBeNull();
  });

  it('to somebody whose rating is already on the row', async () => {
    const { queued, row } = await stops({ rating: 5 });

    expect(queued).toHaveLength(0);
    expect(row.reminderDueAt).toBeNull();
  });

  it('to somebody with a matched NPS submission', async () => {
    const { queued } = await stops({ _count: { npsResponses: 1 } });

    expect(queued).toHaveLength(0);
  });

  it('to somebody who wrote back on WhatsApp', async () => {
    // A reply is not a submission — but it does mean a colleague is in a
    // conversation with this customer, and a scheduled chaser landing in the
    // middle of it is the software talking over a person.
    const { queued } = await stops({ repliedAt: AT('2026-11-16T09:00:00Z') });

    expect(queued).toHaveLength(0);
  });

  it('when the first request was handed to a colleague instead of WhatsApp', async () => {
    const { queued } = await stops({ taskId: 'task_ask_in_person', sentAt: null });

    expect(queued).toHaveLength(0);
  });

  it('when the first request never left', async () => {
    const { queued } = await stops({ sentAt: null });

    expect(queued).toHaveLength(0);
  });

  it('when the first request was cancelled', async () => {
    const { queued } = await stops({ status: 'cancelled' });

    expect(queued).toHaveLength(0);
  });

  it('to a customer who has been archived', async () => {
    const { queued } = await stops({ party: { name: 'Priya Shah', archivedAt: NOW } });

    expect(queued).toHaveLength(0);
  });

  it('when the organisation has only ever configured one request', async () => {
    const { queued, row } = await stops({}, ONE_STEP_ONLY);

    expect(queued).toHaveLength(0);
    expect(row.reminderDueAt).toBeNull();
  });
});

describe('confirming that the second request left', () => {
  it('stamps the time the provider took it, not the time it was composed', async () => {
    const { service, rows } = harness({
      rows: [askRow({ reminderDueAt: null, reminderMessageId: 'msg_second' })],
      messages: [{ id: 'msg_second', status: 'sent', sentAt: AT('2026-11-17T05:41:00Z'), error: null }],
    });

    const outcome = await service.sweep(NOW);

    expect(outcome.secondSettled).toBe(1);
    expect(rows[0].reminderSentAt).toEqual(AT('2026-11-17T05:41:00Z'));
  });

  it('leaves a refused message unsent rather than calling it sent', async () => {
    const { service, rows } = harness({
      rows: [askRow({ reminderDueAt: null, reminderMessageId: 'msg_second' })],
      messages: [
        { id: 'msg_second', status: 'failed', sentAt: AT('2026-11-17T05:41:00Z'), error: 'refused' },
      ],
    });

    await service.sweep(NOW);

    expect(rows[0].reminderSentAt).toBeNull();
  });
});

describe('booking the requests when a visit closes', () => {
  it('books the first one at the instant it has always been booked at', async () => {
    // The whole compatibility promise, at the layer that actually writes it:
    // seven days at 11:00 branch time, from a visit that closed at 23:30 IST
    // on 1 November. Anything else moves every already-configured tenant's send.
    const { service, created } = harness({ rows: [], policy: ONE_STEP_ONLY });

    const result = await service.scheduleAfterVisit({
      organisationId: 'org_nibhana',
      checkIn: { id: 'ci_new', storeId: 'store_bandra', partyId: 'party_new' },
      closedAt: AT('2026-11-01T18:00:00Z'),
      timezone: IST,
      createdById: 'rep_bandra',
    });

    expect(result.scheduled).toBe(true);
    expect(result.scheduledFor?.toISOString()).toBe('2026-11-08T05:30:00.000Z');
    expect(created[0].scheduledFor).toEqual(AT('2026-11-08T05:30:00.000Z'));
    // And nothing plans a chaser at checkout: it is planned only once the first
    // request has actually reached the customer.
    expect(created[0].reminderDueAt).toBeUndefined();
  });

  /** A first request waiting to go out, with no chaser planned yet. */
  const waitingToSend = () =>
    askRow({
      status: 'scheduled',
      messageId: null,
      sentAt: null,
      scheduledFor: AT('2026-11-16T05:30:00Z'),
      reminderDueAt: null,
    });

  it('plans the second one only once the first has gone to the customer', async () => {
    const { service, rows } = harness({ rows: [waitingToSend()] });

    // The first request goes out at its own hour, 24 hours after the visit.
    await service.sweep(AT('2026-11-16T05:30:00Z'));

    expect(rows[0].status).toBe('pending');
    expect(rows[0].messageId).toBe('msg_1');
    // 48 hours from a visit that closed at 23:30 IST on the 15th, at 11:00
    // branch time: the 17th. Measured from the VISIT, as the client states it.
    expect((rows[0].reminderDueAt as Date | null)?.toISOString()).toBe('2026-11-17T05:30:00.000Z');
  });

  it('pushes the second one out by the configured gap when the first went late', async () => {
    const { service, rows } = harness({ rows: [waitingToSend()] });

    // A day late — a sweep that retried, or WhatsApp down over a weekend.
    await service.sweep(AT('2026-11-17T05:40:00Z'));

    /*
     * Anchored purely to the visit this would already be overdue and would go
     * out minutes after the first, which is two messages in a row rather than a
     * follow-up. The 24 hours BETWEEN the steps is what the tenant chose, so
     * that is what is kept: the 18th at 05:40, not the 17th at 05:30.
     */
    expect((rows[0].reminderDueAt as Date | null)?.toISOString()).toBe('2026-11-18T05:40:00.000Z');
  });

  it('plans nothing when the organisation has configured only one request', async () => {
    const { service, rows } = harness({ rows: [waitingToSend()], policy: ONE_STEP_ONLY });

    await service.sweep(NOW);

    expect(rows[0].status).toBe('pending');
    expect(rows[0].reminderDueAt).toBeNull();
  });

  it('cancels a planned chaser when the first request ends up with a colleague', async () => {
    // Reached when the outbox finally marks the first message failed, by which
    // time `reminderDueAt` is already set. A chaser reading "following up on my
    // earlier message" would then be the first thing this customer ever heard.
    const { service, rows } = harness({
      rows: [askRow({ status: 'pending', sentAt: null, taskId: null })],
      messages: [{ id: 'msg_first', status: 'failed', sentAt: null, error: 'refused' }],
    });

    await service.sweep(NOW);

    expect(rows[0].taskId).toBe('task_1');
    expect(rows[0].reminderDueAt).toBeNull();
    expect(rows[0].reminderSentAt).toBeNull();
  });
});
