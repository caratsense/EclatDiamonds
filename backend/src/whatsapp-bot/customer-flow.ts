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

/**
 * The steps, in order. Four questions, and the fifth only when someone asks to
 * be called later.
 *
 * It used to be six, with a branch: an engagement ring also got asked its
 * diamond shape, and everyone was asked who the piece was for. Both are gone.
 *
 * The shape question was the worst of them. It arrives before anyone has shown
 * a customer a single ring, it reads as a quiz rather than a conversation, and
 * the answer changes nothing the salesperson does on the call. Who the piece is
 * for went the same way: pleasant to know, never acted on, and one more thing
 * between an interested person and a human being.
 *
 * What is left is what a salesperson genuinely needs before they ring someone:
 * what they want, what they will spend, when they want it, and whether a call
 * is welcome. Nothing is asked that nobody reads.
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
    next: () => 'budget',
  },
  {
    key: 'budget',
    prompt: 'What is your approximate budget?',
    
    options: [
      { value: 'under_50k', label: 'Under ₹50K' },
      { value: '50k_1l', label: '₹50K to ₹1L' },
      { value: '1l_2l', label: '₹1L to ₹2L' },
      { value: 'above_2l', label: 'Above ₹2L' },
    ],
    next: () => 'timeline',
  },
  {
    key: 'timeline',
    prompt: 'When are you planning to purchase?',
    options: [
      { value: 'within_7_days', label: 'Within 7 days' },
      { value: 'this_month', label: 'This month' },
      { value: '1_3_months', label: 'In a few months' },
      { value: 'exploring', label: 'Just exploring' },
    ],
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
 * There is no branching left: the one branch there was sent engagement-ring
 * buyers to a diamond-shape question that has since been removed. The signature
 * keeps `answers` because `firstUnanswered` walks the flow through here, and
 * because the next question that needs context should not have to reintroduce
 * it.
 */
export function resolveNext(
  step: FlowStep,
  value: string,
  _answers: Record<string, string>,
): string | null {
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
 * Words a customer actually types that mean an option, beyond its label.
 *
 * Keyed by option VALUE so a label can be reworded without silently breaking
 * what the bot understands. Deliberately narrow: every entry here is a phrase
 * that can only mean one thing in the context of its own question, because a
 * synonym that matches two options is worse than one that matches none — the
 * first stores a guess, the second re-asks.
 */
const SYNONYMS: Record<string, string[]> = {
  engagement_ring: ['engagement', 'proposal', 'propose', 'solitaire', 'ring'],
  wedding_jewellery: ['wedding', 'bridal', 'marriage', 'shaadi'],
  daily_wear: ['daily', 'everyday', 'office', 'regular'],
  other: ['other', 'something else', 'not sure'],

  myself: ['myself', 'me', 'self', 'my own'],
  partner: ['partner', 'wife', 'husband', 'fiance', 'fiancee', 'girlfriend', 'boyfriend'],
  family: ['family', 'mother', 'mom', 'mum', 'father', 'dad', 'sister', 'brother'],
  gift: ['gift', 'present', 'friend'],

  under_50k: ['under 50', 'below 50', 'less than 50', '50k', '40k', '30k'],
  '50k_1l': ['50 to 1', '50-1', '1 lakh', '1l', '75k'],
  '1l_2l': ['1 to 2', '1-2', '2 lakh', '2l', '1.5'],
  above_2l: ['above 2', 'more than 2', 'over 2', '3 lakh', '5 lakh'],

  within_7_days: ['this week', 'week', 'urgent', 'asap', 'soon', '7 days'],
  this_month: ['this month', 'month'],
  '1_3_months': ['few months', '2 months', '3 months'],
  exploring: ['exploring', 'just looking', 'browsing', 'no hurry', 'not decided'],

  call_now: ['yes', 'yeah', 'sure', 'ok', 'okay', 'please call', 'call me', 'call now', 'right now', 'now'],
  call_later: ['later', 'not now but', 'afterwards'],
  not_now: ['no', 'nope', 'not now', 'not interested', 'dont call'],

  later_today: ['today', 'this evening'],
  tomorrow_am: ['tomorrow morning', 'morning'],
  tomorrow_pm: ['tomorrow evening', 'tomorrow night'],
  weekend: ['weekend', 'saturday', 'sunday'],
  i_will_message: ['i will message', 'ill message', 'i will text', 'let me message'],
};

/** Strip everything that is not a letter or digit, for comparison. */
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The text as whole words, single-spaced. A phrase is looked for as WORDS, not
 * as letters: squashed together, "no" is inside "now", "ring" is inside
 * "earrings" and "5 lakh" is inside "1.5 lakh", and each of those filed a
 * wrong answer. Apostrophes go ("don't" is "dont"); "1.5" and "50k" stay whole.
 */
const wordsOf = (t: string) =>
  (t.toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+(?:\.[0-9]+)?/g) ?? []).join(' ');

/**
 * Read one answer.
 *
 * Customers do not answer a question with a number. They write "engagement
 * ring", "for my wife", "around 1 lakh", "yes please call me" — and the flow
 * was reading none of it, so a perfectly clear reply got "Sorry, I didn't quite
 * catch that" and two of those hand the lead to a person who then has to start
 * the conversation again.
 *
 * Four passes, most confident first:
 *
 *   1. a bare position        "2", "2.", "2)"
 *   2. the label, or its value
 *   3. the label as a PREFIX  "enga" -> Engagement Ring
 *   4. the label or a synonym appearing anywhere in the sentence
 *
 * Every pass requires EXACTLY ONE match. An ambiguous sentence returns null and
 * is re-asked, because a misread budget is a mis-scored lead — and the customer
 * is still there to clarify, which they are not once the wrong answer is filed.
 */
export function parseChoice(step: FlowStep, raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[.)\]]+$/, '');
  if (!s) return null;

  // 1 — a number on its own. NOT a number inside a sentence: "1 lakh" is a
  // budget, not option one.
  if (/^\d+$/.test(s)) {
    const idx = Number(s) - 1;
    return step.options[idx]?.value ?? null;
  }

  const target = norm(s);
  if (!target) return null;

  // 2 — the whole message is the label, or the stored value.
  const exact = step.options.filter((o) => norm(o.label) === target || o.value === s);
  if (exact.length === 1) return exact[0].value;

  // 3 — the message is the start of exactly one label.
  const prefix = step.options.filter((o) => norm(o.label).startsWith(target));
  if (prefix.length === 1) return prefix[0].value;

  /*
   * 4 — a real sentence. Match the label or a known synonym anywhere inside it,
   * as whole words (see wordsOf), so "₹1L–₹2L" is reachable from "1 to 2 lakh"
   * and "now" is never read as "no".
   *
   * Scored by the LENGTH of the matched phrase so a longer, more specific
   * phrase wins: "tomorrow morning" must beat the bare "morning", exactly as
   * the ad-set rules prefer the longer showroom name.
   */
  let best: { value: string; length: number } | null = null;
  let tied = false;

  const sentence = ` ${wordsOf(s)} `;
  for (const option of step.options) {
    const phrases = [option.label, ...(SYNONYMS[option.value] ?? [])];
    for (const phrase of phrases) {
      const needle = wordsOf(phrase);
      if (!needle || !sentence.includes(` ${needle} `)) continue;
      if (!best || needle.length > best.length) {
        best = { value: option.value, length: needle.length };
        tied = false;
      } else if (needle.length === best.length && best.value !== option.value) {
        tied = true;
      }
    }
  }

  return best && !tied ? best.value : null;
}

/** The label for a stored value, for summaries and handoff notes. */
export function labelFor(stepKey: string, value: string): string | undefined {
  return STEP_BY_KEY.get(stepKey)?.options.find((o) => o.value === value)?.label;
}

/**
 * The question as the customer sees it.
 *
 * NO NUMBERED LIST, AND NO DASHES. Both were a tell.
 *
 * It used to render as "1 — Engagement Ring / 2 — Wedding Jewellery", with
 * "Reply with a number" underneath. A shop assistant does not hand you a
 * numbered menu, and an em dash is not something people type into WhatsApp, so
 * between them the message announced itself as machine-written before it had
 * said anything. The options stay, because they tell somebody what kind of
 * answer is useful; they are simply listed the way a person would list them.
 *
 * `parseChoice` still accepts "1" or "2" from anyone who types one out of
 * habit. That tolerance is deliberately not advertised: answering in words is
 * the path we want people on, and "or send a number" is what put them on the
 * other one.
 */
export function promptFor(step: FlowStep): string {
  const lines = [`*${step.prompt}*`];
  if (step.hint) lines.push(`_${step.hint}_`);
  lines.push('');
  step.options.forEach((o) => lines.push(o.label));
  lines.push('', '_Just tell me in your own words._');
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
    "Just a couple of quick questions so I can show you the right pieces. Takes under a minute.",
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
          return `Perfect. I'm connecting you with ${team} now, they'll take it from here. 💎`;
        case 'returning':
          // Someone who has already been through the script. Asking their
          // budget a second time is what makes a bot feel like a form, and
          // their answers are already on the thread — a person takes it on.
          return [
            'Good to hear from you again 👋',
            '',
            `I've passed this to ${team}. Someone will reply here shortly. 💎`,
          ].join('\n');
        default:
          return `Noted. ${team} will call you then. 💎`;
      }
    case 'parked':
      return [
        'No problem at all, no pressure from us.',
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
    'You can answer in your own words, or just say *call me* and I will connect you with someone.',
  ].join('\n');
}

/** Opt-out. Checked before anything else, on every inbound message. */
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'opt out', 'optout', 'do not message me']);

export function isStop(raw: string): boolean {
  return STOP_WORDS.has(raw.trim().toLowerCase());
}

export function stopConfirmation(): string {
  return "Understood, I won't message you again. If you change your mind, just message us here. 💎";
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
