import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FIRST_STEP,
  FLOW_STEPS,
  FlowOutcome,
  MAX_REPROMPTS,
  closingFor,
  firstUnanswered,
  greeting,
  handoffSummary,
  isStop,
  labelFor,
  parseChoice,
  promptFor,
  reprompt,
  resolveNext,
  stepByKey,
  stopConfirmation,
  wantsHuman,
} from './customer-flow';

/**
 * The customer-facing qualification bot.
 *
 * Sits opposite `WhatsAppConversationService`: that one talks to staff who are
 * known users filing reports, this one talks to strangers who clicked an ad. The
 * shapes are deliberately the same — a session row, one question at a time, a
 * parser that returns null rather than guessing — because the failure mode is
 * the same. A misread answer here is a mis-scored lead and a salesperson's
 * wasted afternoon.
 *
 * State lives in the existing `WhatsAppSession` under `flow: 'customer'`, so
 * this needs no migration. Answers and bookkeeping share `draft`, with the
 * underscore-prefixed key convention `dsr-flow.ts` already established.
 */

/** Session bookkeeping inside `draft`, kept out of the answer namespace. */
const STEP_KEY = '_step';
const REPROMPT_KEY = '_reprompts';

/** Matches the staff bot: an abandoned half-conversation must not resurface. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CustomerBotReply {
  /** What to send back. Empty string means send nothing. */
  text: string;
  /**
   * Set only when the bot's turn is over. The caller decides what it means
   * operationally — assigning a branch manager is not this service's job.
   */
  outcome?: FlowOutcome;
  /** Everything captured, for the lead record. */
  answers?: Record<string, string>;
  /** A note for the manager picking the thread up. */
  handoffNote?: string;
  /** The customer asked never to be messaged again. */
  optOut?: boolean;
}

type Draft = Record<string, string | number>;

@Injectable()
export class CustomerBotService {
  private readonly logger = new Logger(CustomerBotService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Handle one inbound customer message.
   *
   * `known` carries anything the lead form already captured, keyed by step. Those
   * steps are skipped rather than re-asked — being asked the same question twice
   * within two minutes is the fastest way to lose someone who was interested.
   */
  async handle(
    phoneE164: string,
    organisationId: string,
    rawText: string,
    known: Record<string, string> = {},
    firstName?: string,
  ): Promise<CustomerBotReply> {
    const text = (rawText ?? '').trim();

    // Opt-out is checked before anything else, on every message, whatever the
    // conversation was doing. A customer who says stop while mid-question must
    // not first be re-asked the question.
    if (isStop(text)) {
      await this.clear(phoneE164);
      return { text: stopConfirmation(), optOut: true };
    }

    const session = await this.load(phoneE164);
    const draft = (session.draft ?? {}) as Draft;
    const answers = this.answersOf(draft, known);

    // "call me" at any point short-circuits the script. Continuing to ask about
    // diamond shapes after someone has asked for a person reads as a bot that is
    // not listening, and it is the moment they are most likely to leave.
    if (wantsHuman(text)) {
      await this.clear(phoneE164);
      return {
        text: closingFor({ kind: 'handoff', reason: 'wants_call' }),
        outcome: { kind: 'handoff', reason: 'wants_call' },
        answers,
        handoffNote: handoffSummary(answers),
      };
    }

    const currentKey = typeof draft[STEP_KEY] === 'string' ? (draft[STEP_KEY] as string) : null;

    // No step in flight — this is the opening message.
    if (!currentKey) {
      const first = firstUnanswered(answers, FIRST_STEP);
      if (!first) {
        // The form answered everything. Go straight to the call ask rather than
        // inventing a question to justify the bot's existence.
        return this.ask(phoneE164, organisationId, draft, 'call', greeting(firstName));
      }
      return this.ask(phoneE164, organisationId, draft, first, greeting(firstName));
    }

    const step = stepByKey(currentKey);
    if (!step) {
      // The flow changed under a live session. Start again rather than crash.
      this.logger.warn(`Unknown step "${currentKey}" in session for ${mask(phoneE164)} — restarting.`);
      await this.clear(phoneE164);
      return this.handle(phoneE164, organisationId, text, known, firstName);
    }

    const value = parseChoice(step, text);

    if (value === null) {
      const tries = Number(draft[REPROMPT_KEY] ?? 0) + 1;
      if (tries > MAX_REPROMPTS) {
        // Asking a third time is how a bot traps someone. Fetch a person.
        await this.clear(phoneE164);
        return {
          text: closingFor({ kind: 'handoff', reason: 'gave_up' }),
          outcome: { kind: 'handoff', reason: 'gave_up' },
          answers,
          handoffNote: handoffSummary(answers),
        };
      }
      await this.save(phoneE164, organisationId, { ...draft, [REPROMPT_KEY]: tries });
      return { text: `${reprompt()}\n\n${promptFor(step)}` };
    }

    const nextDraft: Draft = { ...draft, [step.key]: value, [REPROMPT_KEY]: 0 };
    const nextAnswers = this.answersOf(nextDraft, known);
    const nextKey = resolveNext(step, value, nextAnswers);

    if (nextKey) {
      return this.ask(phoneE164, organisationId, nextDraft, nextKey);
    }

    // The flow is over. Which ending depends on the last answer.
    await this.clear(phoneE164);
    const outcome = endingFor(step.key, value);
    return {
      text: closingFor(outcome),
      outcome,
      answers: nextAnswers,
      handoffNote: outcome.kind === 'handoff' ? handoffSummary(nextAnswers) : undefined,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Persist the next step and return its prompt, optionally after a preamble. */
  private async ask(
    phoneE164: string,
    organisationId: string,
    draft: Draft,
    stepKey: string,
    preamble?: string,
  ): Promise<CustomerBotReply> {
    const step = stepByKey(stepKey);
    if (!step) {
      // Should be unreachable; refusing loudly beats replying with nothing.
      this.logger.error(`ask() called with unknown step "${stepKey}".`);
      return { text: '' };
    }
    await this.save(phoneE164, organisationId, {
      ...draft,
      [STEP_KEY]: stepKey,
      [REPROMPT_KEY]: 0,
    });
    const body = promptFor(step);
    return { text: preamble ? `${preamble}\n\n${body}` : body };
  }

  /**
   * Answers only — the underscore keys are bookkeeping, and letting them into
   * the answer map would corrupt `firstUnanswered` and the handoff note.
   *
   * Lead-form answers sit underneath: a value the customer has actually typed
   * wins over one the form guessed at.
   */
  private answersOf(draft: Draft, known: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(known)) {
      if (stepByKey(k) && labelFor(k, v) !== undefined) out[k] = v;
    }
    for (const [k, v] of Object.entries(draft)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  private async load(phoneE164: string) {
    const now = new Date();
    const existing = await this.prisma.whatsAppSession.findUnique({ where: { phoneE164 } });
    if (!existing || existing.expiresAt <= now || existing.flow !== 'customer') {
      return { flow: 'customer', step: 0, draft: {} as Prisma.JsonValue };
    }
    return existing;
  }

  private async save(phoneE164: string, organisationId: string, draft: Draft) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.whatsAppSession.upsert({
      where: { phoneE164 },
      create: {
        phoneE164,
        organisationId,
        flow: 'customer',
        step: 0,
        draft: draft as Prisma.InputJsonValue,
        expiresAt,
      },
      update: {
        organisationId,
        flow: 'customer',
        draft: draft as Prisma.InputJsonValue,
        expiresAt,
      },
    });
  }

  private async clear(phoneE164: string) {
    await this.prisma.whatsAppSession
      .delete({ where: { phoneE164 } })
      .catch(() => undefined); // nothing to clear is the normal case, not an error
  }
}

/** Which ending the last answer means. */
function endingFor(stepKey: string, value: string): FlowOutcome {
  if (stepKey === 'call') {
    if (value === 'call_now') return { kind: 'handoff', reason: 'wants_call' };
    return { kind: 'parked', reason: 'not_now' };
  }
  // call_time — a slot was chosen, so somebody has to ring them.
  return { kind: 'handoff', reason: 'wants_call_later' };
}

/** Same masking rule as `whatsapp.service.ts`: logs outlive the data they describe. */
function mask(phone: string): string {
  return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
}

/** Re-exported so callers do not need to import the flow module directly. */
export { FLOW_STEPS };
