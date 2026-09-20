/**
 * The customer qualification conversation, and the parsing behind it.
 *
 * Pure functions on purpose, for the same reason `dsr-flow.ts` is: this decides
 * what a stranger who clicked an ad is asked, and in what order, so it must be
 * testable without a database or WhatsApp.
 *
 * Scripted rather than generated. Every reply here is written copy the client
 * has approved; nothing improvises. A model that invents a price, a policy or a
 * showroom does commercial damage that no amount of prompt tuning makes
 * acceptable.
 *
 * Options are rendered as a NUMBERED TEXT MENU rather than WhatsApp interactive
 * buttons, because `WhatsAppService` can currently only send `text` and
 * `template`. The step shapes below already carry everything an interactive
 * message needs — list rows are titles under 24 characters — so swapping the
 * renderer later changes `promptFor` and nothing else.
 */

/** One tappable answer. `value` is stored; `label` is shown. */
export interface FlowOption {
  value: string;
  /** Kept to 24 characters so it can become a WhatsApp list row unchanged. */
  label: string;
}

export interface FlowStep {
  key: string;
  prompt: string;
  /** Shown under the prompt, e.g. to soften a budget question. */
  hint?: string;
  options: FlowOption[];
  /**
   * Which step follows, given the answer. `null` ends the bot's turn — either a
   * handoff to a person or a close.
   */
  next(value: string): string | null;
}

/** Where the flow ends, and why. The caller decides what to do about it. */
export type FlowOutcome =
  | { kind: 'handoff'; reason: 'wants_call' | 'wants_call_later' | 'gave_up' | 'returning' }
  | { kind: 'parked'; reason: 'not_now' };

export const RING_SHAPES: FlowOption[] = [
  { value: 'round', label: 'Round' },
  { value: 'oval', label: 'Oval' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'princess', label: 'Princess' },
  { value: 'pear', label: 'Pear' },
  { value: 'unsure', label: 'Other' },
];

/**
 * The steps, in order.
 *
 * `looking_for` branches: an engagement ring gets the shape question, everything
 * else goes straight to the call ask. That branch is the only place the order
 * changes, which is why `next` is a function rather than a field.
 */
export const FLOW_STEPS: FlowStep[] = [
  {
    key: 'looking_for',
    prompt: 'What are you looking for today?',
    options: [
      { value: 'engagement_ring', label: 'Engagement Ring' },
      { value: 'wedding_jewellery', label: 'Wedding Jewellery' },
      { value: 'daily_wear', label: 'Daily Wear' },
      { value: 'other', label: 'Other Jewellery' },
    ],
    next: () => 'who_for',
  },
  {
    key: 'who_for',
    prompt: 'Is this purchase for yourself or someone special?',
    options: [
      { value: 'myself', label: 'Myself' },
      { value: 'partner', label: 'Partner' },
      { value: 'family', label: 'Family' },
      { value: 'gift', label: 'Gift' },
    ],
    next: () => 'budget',
  },
  {
    key: 'budget',
    prompt: 'What is your approximate budget?',
    
    options: [
      { value: 'under_50k', label: 'Under ₹50K' },
      { value: '50k_1l', label: '₹50K – ₹1L' },
      { value: '1l_2l', label: '₹1L – ₹2L' },
      { value: 'above_2l', label: '₹2L+' },
    ],
    next: () => 'timeline',
  },
  {
    key: 'timeline',
    prompt: 'When are you planning to purchase?',
    options: [
      { value: 'within_7_days', label: 'Within 7 days' },
      { value: 'this_month', label: 'This month' },
      { value: '1_3_months', label: '1–3 months' },
      { value: 'exploring', label: 'Just exploring' },
    ],
    // The shape question only makes sense for a ring; see resolveNext().
    next: () => 'call',
  },
  {
    key: 'ring_shape',
    prompt: 'Do you have a preferred diamond shape?',
    hint: 'I can send you a link with those rings.',
    options: RING_SHAPES,
    next: () => 'call',
  },
  {
    key: 'call',
    prompt: 'Our team can talk you through designs, pricing and customisation. Would a quick call work?',
    options: [
      { value: 'call_now', label: 'Yes, call me now' },
      { value: 'call_later', label: 'Call me later' },
      { value: 'not_now', label: 'Not right now' },
    ],
    next: (v) => (v === 'call_later' ? 'call_time' : null),
  },
  {
    key: 'call_time',
    prompt: 'Of course. When suits you best?',
    options: [
      { value: 'later_today', label: 'Later today' },
      { value: 'tomorrow_am', label: 'Tomorrow morning' },
      { value: 'tomorrow_pm', label: 'Tomorrow evening' },
      { value: 'weekend', label: 'This weekend' },
      { value: 'i_will_message', label: "I'll message you" },
    ],
    next: () => null,
  },
];

const STEP_BY_KEY = new Map(FLOW_STEPS.map((s) => [s.key, s]));

export function stepByKey(key: string): FlowStep | undefined {
  return STEP_BY_KEY.get(key);
}

export const FIRST_STEP = 'looking_for';

/**
 * The next step, given the whole answer set rather than just the last answer.
 *
 * `timeline` is followed by the shape question only when the customer said they
 * want an engagement ring. Asking a wedding-jewellery buyer which diamond shape
 * they want reads as a bot that is not listening.
 */
export function resolveNext(
  step: FlowStep,
  value: string,
  answers: Record<string, string>,
): string | null {
  if (step.key === 'timeline' && answers.looking_for === 'engagement_ring') {
    return 'ring_shape';
  }
  return step.next(value);
}

/**
 * Lead-form answers that make a step redundant.
 *
 * The 7-slide ad form already asks occasion, budget and visit intent. Asking the
 * same three again two minutes later is the fastest way to lose someone who was
 * interested, so a step whose answer is already known is skipped rather than
 * re-asked.
 */
export function firstUnanswered(
  answers: Record<string, string>,
  from: string = FIRST_STEP,
): string | null {
  let key: string | null = from;
  const seen = new Set<string>();
  while (key) {
    if (seen.has(key)) return null; // defensive: a cycle must not hang the bot
    seen.add(key);
    const step = STEP_BY_KEY.get(key);
    if (!step) return null;
    if (answers[key] === undefined) return key;
    key = resolveNext(step, answers[key], answers);
  }
  return null;
}

/**
 * Read one answer.
 *
 * Accepts the position ("2", "2.", "2)"), the label ("oval"), or an unambiguous
 * prefix of it. Returns null when it cannot be read, so the caller re-asks
 * rather than storing a guess — a misread budget is a mis-scored lead.
 */
export function parseChoice(step: FlowStep, raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[.)\]]+$/, '');
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    const idx = Number(s) - 1;
    return step.options[idx]?.value ?? null;
  }

  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(s);
  if (!target) return null;

  const exact = step.options.filter((o) => norm(o.label) === target || o.value === s);
  if (exact.length === 1) return exact[0].value;

  const prefix = step.options.filter((o) => norm(o.label).startsWith(target));
  return prefix.length === 1 ? prefix[0].value : null;
}

/** The label for a stored value, for summaries and handoff notes. */
export function labelFor(stepKey: string, value: string): string | undefined {
  return STEP_BY_KEY.get(stepKey)?.options.find((o) => o.value === value)?.label;
}

/**
 * The question as the customer sees it.
 *
 * A numbered list, because `sendText` is what exists today. When interactive
 * messages land, this becomes the only function that changes.
 */
export function promptFor(step: FlowStep): string {
  const lines = [`*${step.prompt}*`];
  if (step.hint) lines.push(`_${step.hint}_`);
  lines.push('');
  step.options.forEach((o, i) => lines.push(`${i + 1} — ${o.label}`));
  lines.push('', '_Reply with a number._');
  return lines.join('\n');
}

/**
 * How a step should be sent, given WhatsApp's shape limits.
 *
 * Three options or fewer fit reply buttons; up to ten need a list; anything
 * else falls back to the numbered text menu. The caller picks the matching
 * `WhatsAppService` method. Keeping the decision here means the flow stays the
 * single place that knows what a question looks like.
 */
export type RenderedStep =
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | {
      kind: 'list';
      body: string;
      buttonText: string;
      rows: { id: string; title: string }[];
    }
  | { kind: 'text'; body: string };

export function renderFor(step: FlowStep): RenderedStep {
  const body = step.hint ? `*${step.prompt}*

_${step.hint}_` : `*${step.prompt}*`;
  const rows = step.options.map((o) => ({ id: `${step.key}:${o.value}`, title: o.label }));

  if (step.options.length <= 3) {
    return { kind: 'buttons', body, buttons: rows.map((r) => ({ id: r.id, title: r.title })) };
  }
  if (step.options.length <= 10) {
    return { kind: 'list', body, buttonText: 'Choose one', rows };
  }
  return { kind: 'text', body: promptFor(step) };
}

/**
 * Read an interactive reply.
 *
 * WhatsApp returns the row or button id we sent, which we namespace as
 * `stepKey:value` so a stale tap on an earlier question cannot be mistaken for
 * an answer to the current one.
 */
export function parseInteractiveId(step: FlowStep, id: string): string | null {
  const [stepKey, value] = id.split(':');
  if (stepKey !== step.key) return null;
  return step.options.some((o) => o.value === value) ? value : null;
}

/** Opening message. The name comes from the lead form, so it is usually known. */
export function greeting(firstName?: string): string {
  const hi = firstName ? `Hi ${firstName} 👋` : 'Hi 👋';
  return [
    hi,
    '',
    'Thanks for reaching out to *Éclat Diamonds*.',
    '',
    "I'll ask a couple of quick questions so I can show you the right pieces — it takes under a minute.",
  ].join('\n');
}

/**
 * What the customer is told when the bot's turn ends.
 *
 * `not_now` deliberately leaves the thread open rather than closing it: the
 * customer-care window stays usable, and a later message costs nothing.
 */
export function closingFor(outcome: FlowOutcome, branch?: string): string {
  const team = branch ? `our *${branch}* team` : 'our team';
  switch (outcome.kind) {
    case 'handoff':
      switch (outcome.reason) {
        case 'wants_call':
          return `Perfect — I'm connecting you with ${team} now. They'll take it from here. 💎`;
        case 'returning':
          // Someone who has already been through the script. Asking their
          // budget a second time is what makes a bot feel like a form, and
          // their answers are already on the thread — a person takes it on.
          return [
            'Good to hear from you again 👋',
            '',
            `I've passed this to ${team} — someone will reply here shortly. 💎`,
          ].join('\n');
        default:
          return `Noted — ${team} will call you then. 💎`;
      }
    case 'parked':
      return [
        'No problem at all — no pressure from us.',
        '',
        '📷 Send me a photo of any design you like and I can get you a price.',
        '',
        'Just message here whenever you are ready.',
      ].join('\n');
  }
}

/** The bot could not read two answers in a row: stop guessing, fetch a person. */
export const MAX_REPROMPTS = 2;

export function reprompt(): string {
  return [
    "Sorry, I didn't quite catch that.",
    '',
    'You can reply with the number of an option above — or say *call me* and I will connect you with someone.',
  ].join('\n');
}

/** Opt-out. Checked before anything else, on every inbound message. */
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'opt out', 'optout', 'do not message me']);

export function isStop(raw: string): boolean {
  return STOP_WORDS.has(raw.trim().toLowerCase());
}

export function stopConfirmation(): string {
  return "Understood — I won't message you again. If you change your mind, just message us here. 💎";
}

/** A customer asking for a person at any point short-circuits the flow. */
const ESCALATION_WORDS = /\b(call me|talk to|speak to|human|agent|manager|representative)\b/i;

export function wantsHuman(raw: string): boolean {
  return ESCALATION_WORDS.test(raw);
}

/** The note a branch manager sees when a thread reaches them. */
export function handoffSummary(answers: Record<string, string>): string {
  const parts: string[] = [];
  for (const step of FLOW_STEPS) {
    const v = answers[step.key];
    if (v === undefined) continue;
    const label = labelFor(step.key, v) ?? v;
    parts.push(`${step.prompt.replace(/\?$/, '')}: ${label}`);
  }
  return parts.length ? parts.join('\n') : 'No answers captured before handoff.';
}
