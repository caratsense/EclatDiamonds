/**
 * CRM qualification policy (Phase A9) — the tenant's own rules, as data.
 *
 * THE CENTRAL DESIGN DECISION, stated up front because it is what keeps this
 * honest: **the model never decides the score.**
 *
 *   text → (extraction) → signals → POLICY → score → band → action
 *
 * Extraction is the only part an AI provider does, and all it produces is
 * "which of the tenant's signals appear in this conversation, and what is the
 * evidence". Everything after that is arithmetic over rules the tenant owns.
 *
 * Three things follow from that, all of them properties we want:
 *
 *  1. NOTHING LIKE `score > 65 = hot` IS COMPILED IN. Bands, weights, questions
 *     and thresholds are configuration. The constants below are a STARTING
 *     POINT a tenant edits, not a rule the platform enforces — a pharmacy's
 *     idea of a qualified enquiry is not a jeweller's.
 *  2. IT WORKS WITH NO AI PROVIDER AT ALL. Keyword matching over the tenant's
 *     own signal phrases is a real, deterministic, fully explainable
 *     qualification — not a degraded stand-in for the "real" one. A provider
 *     improves extraction; it does not unlock scoring.
 *  3. EVERY SCORE CAN BE DEFENDED. Each signal returns the phrase that matched,
 *     and the policy version is stored on the row, so a score can be explained
 *     in terms of the rules that were in force when it was produced rather than
 *     the rules as they stand today.
 */

/** One thing worth noticing in a conversation. */
export interface QualificationSignal {
  /** Stable key, referenced by extraction output. */
  key: string;
  /** What a human calls it. */
  label: string;
  /**
   * Contribution to the score when this fires. Negative is meaningful and
   * deliberate: "asked for a refund" should push a score DOWN, and a policy that
   * can only add is a policy that can only ever say "hot".
   */
  weight: number;
  /**
   * Phrases that fire this signal without any AI, matched case-insensitively on
   * word boundaries. Also given to a provider as examples of what the tenant
   * means, so the two paths look for the same thing.
   */
  phrases: string[];
  /** Optional note shown in the UI to explain what this signal is for. */
  hint?: string;
}

/** A score range and what the tenant calls it. */
export interface QualificationBand {
  key: string;
  label: string;
  /** Inclusive lower bound. Bands are evaluated highest-first. */
  minScore: number;
  /** What a human should do next when a lead lands here. */
  recommendedAction: string;
  /** Whether landing here asks a human to take the conversation over. */
  requestHandoff?: boolean;
}

/** A thing the business wants to know before it can quote. */
export interface QualificationQuestion {
  key: string;
  /** The question, in the tenant's words. */
  prompt: string;
  /** Which requirement key an answer populates (budget, occasion, timeline…). */
  requirement: string;
  required?: boolean;
}

export interface QualificationPolicy {
  /** Master switch. Off means no qualification is produced at all. */
  enabled: boolean;
  /**
   * Bumped on every edit and stamped onto each assessment, so a stored score
   * always names the ruleset that produced it.
   */
  version: number;
  signals: QualificationSignal[];
  bands: QualificationBand[];
  questions: QualificationQuestion[];
  /**
   * Below this, the assessment is reported as low-confidence and no action is
   * recommended. Configurable because how much evidence is "enough" is a
   * business judgement, not a platform constant.
   */
  confidenceThreshold: number;
  /** Fewer messages than this and we say so rather than scoring thin air. */
  minMessagesToScore: number;
  /** Ask for a human when the score is at least this. Null disables escalation. */
  handoffAtScore: number | null;
  /** Also ask for a human when any of these signals fire, whatever the score. */
  handoffSignals: string[];
  /** Include a written summary in the output. */
  summarise: boolean;
}

/**
 * The starting policy a tenant gets before they have configured anything.
 *
 * Written in DELIBERATELY GENERIC trade language — "ready to buy", "comparing
 * prices", "wants to visit" are true of a jeweller, a pharmacy and a car
 * dealership alike. There is nothing jewellery-specific here, and there must not
 * be: this file is loaded for every tenant regardless of industry.
 *
 * The numbers are defaults, not doctrine. They exist so a tenant who enables the
 * feature gets something coherent on day one, and every one of them is editable.
 */
export const DEFAULT_QUALIFICATION_POLICY: QualificationPolicy = {
  // OFF by default. Turning on an assessment that starts scoring people the
  // moment the code ships is not a decision the platform gets to make.
  enabled: false,
  version: 1,
  signals: [
    {
      key: 'purchase_intent',
      label: 'Says they want to buy',
      weight: 30,
      phrases: ['want to buy', 'looking to buy', 'i will take', 'ready to buy', 'purchase', 'book it'],
      hint: 'Explicit intent, not just interest.',
    },
    {
      key: 'budget_stated',
      label: 'Mentions a budget',
      weight: 20,
      phrases: ['budget', 'my range', 'around rs', 'under rs', 'how much', 'price range'],
    },
    {
      key: 'timeline_soon',
      label: 'Needs it soon',
      weight: 20,
      phrases: ['this week', 'tomorrow', 'urgent', 'as soon as', 'by friday', 'next week'],
    },
    {
      key: 'visit_intent',
      label: 'Wants to visit',
      weight: 15,
      phrases: ['come to the store', 'visit', 'appointment', 'address', 'timings', 'open today'],
    },
    {
      key: 'specific_item',
      label: 'Asks about a specific item',
      weight: 10,
      phrases: ['do you have', 'is this available', 'in stock', 'this design', 'model'],
    },
    {
      key: 'comparison',
      label: 'Comparing with others',
      weight: 5,
      phrases: ['other shop', 'cheaper', 'competitor', 'somewhere else', 'compare'],
      hint: 'Still a live enquiry, but the sale is not yet won.',
    },
    {
      key: 'complaint',
      label: 'Raising a complaint',
      // Negative on purpose: a complaint is an urgent conversation but it is not
      // a qualified sales lead, and scoring it as one sends the wrong person.
      weight: -25,
      phrases: ['complaint', 'refund', 'not happy', 'broken', 'defective', 'return this'],
    },
    {
      key: 'not_interested',
      label: 'Says they are not interested',
      weight: -40,
      phrases: ['not interested', 'stop messaging', 'do not contact', 'unsubscribe', 'remove my number'],
    },
  ],
  bands: [
    {
      key: 'hot',
      label: 'Ready to talk',
      minScore: 60,
      recommendedAction: 'Call them today.',
      requestHandoff: true,
    },
    { key: 'warm', label: 'Interested', minScore: 30, recommendedAction: 'Send options and follow up in two days.' },
    { key: 'cold', label: 'Early', minScore: 1, recommendedAction: 'Keep on the list; no action needed yet.' },
    {
      key: 'negative',
      label: 'Do not pursue',
      // Reached only by negative signals. Kept as its own band rather than
      // folded into "cold": "asked us to stop" and "not ready yet" need
      // completely different handling, and merging them gets people annoyed.
      minScore: -1000,
      recommendedAction: 'Do not follow up. Check whether they asked to be left alone.',
      requestHandoff: true,
    },
  ],
  questions: [
    { key: 'budget', prompt: 'What budget did they mention?', requirement: 'budget' },
    { key: 'occasion', prompt: 'What is it for?', requirement: 'occasion' },
    { key: 'timeline', prompt: 'When do they need it?', requirement: 'timeline' },
    { key: 'item', prompt: 'What item or category did they ask about?', requirement: 'item' },
  ],
  confidenceThreshold: 0.4,
  minMessagesToScore: 2,
  handoffAtScore: 60,
  handoffSignals: ['complaint', 'not_interested'],
  summarise: true,
};

/**
 * Merge a stored (partial, possibly hand-edited) policy over the defaults.
 *
 * Tolerant on purpose: this reads a JSON blob an admin screen wrote, and a
 * malformed field must degrade to the default rather than throw somewhere deep
 * inside a message handler. A qualification failing is acceptable; a webhook
 * 500ing because someone typo'd a weight is not.
 */
export function resolvePolicy(stored: unknown): QualificationPolicy {
  const base = DEFAULT_QUALIFICATION_POLICY;
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<QualificationPolicy>;

  const signals = Array.isArray(s.signals)
    ? s.signals.filter(isSignal)
    : base.signals;
  const bands = Array.isArray(s.bands) ? s.bands.filter(isBand) : base.bands;

  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : base.enabled,
    version: Number.isInteger(s.version) ? (s.version as number) : base.version,
    // An empty list is treated as "not configured" rather than "score nothing":
    // a policy with no signals can only ever return zero, which would look like
    // a broken feature rather than a configuration mistake.
    signals: signals.length ? signals : base.signals,
    bands: bands.length ? bands : base.bands,
    questions: Array.isArray(s.questions) ? s.questions.filter(isQuestion) : base.questions,
    confidenceThreshold: clamp01(s.confidenceThreshold, base.confidenceThreshold),
    minMessagesToScore:
      Number.isInteger(s.minMessagesToScore) && (s.minMessagesToScore as number) >= 0
        ? (s.minMessagesToScore as number)
        : base.minMessagesToScore,
    handoffAtScore:
      s.handoffAtScore === null || Number.isFinite(s.handoffAtScore as number)
        ? (s.handoffAtScore as number | null)
        : base.handoffAtScore,
    handoffSignals: Array.isArray(s.handoffSignals)
      ? s.handoffSignals.filter((v): v is string => typeof v === 'string')
      : base.handoffSignals,
    summarise: typeof s.summarise === 'boolean' ? s.summarise : base.summarise,
  };
}

function isSignal(v: unknown): v is QualificationSignal {
  const s = v as QualificationSignal;
  return (
    !!s &&
    typeof s.key === 'string' &&
    typeof s.label === 'string' &&
    Number.isFinite(s.weight) &&
    Array.isArray(s.phrases)
  );
}

function isBand(v: unknown): v is QualificationBand {
  const b = v as QualificationBand;
  return (
    !!b &&
    typeof b.key === 'string' &&
    typeof b.label === 'string' &&
    Number.isFinite(b.minScore) &&
    typeof b.recommendedAction === 'string'
  );
}

function isQuestion(v: unknown): v is QualificationQuestion {
  const q = v as QualificationQuestion;
  return !!q && typeof q.key === 'string' && typeof q.prompt === 'string' && typeof q.requirement === 'string';
}

function clamp01(v: unknown, fallback: number): number {
  return Number.isFinite(v as number) && (v as number) >= 0 && (v as number) <= 1
    ? (v as number)
    : fallback;
}

/** One signal's verdict, carrying the evidence that produced it. */
export interface SignalResult {
  key: string;
  label: string;
  weight: number;
  matched: boolean;
  /** The actual text that fired it. Absent when nothing matched. */
  evidence?: string;
}

/**
 * The band a score falls in, under this policy.
 *
 * Shared by the signal path and the manual path, so a 70 typed by a store
 * manager lands in exactly the band a 70 from the assistant would. Two
 * implementations of this would drift, and the day they disagreed the product
 * would be showing the same number under two different labels.
 *
 * `negative` is its own case rather than a low score: "we know they said no" and
 * "we know nothing" are different facts about a customer, and only the signal
 * path can tell them apart.
 */
export function bandForScore(
  policy: QualificationPolicy,
  score: number,
  negative = false,
): QualificationBand | null {
  if (negative) {
    return (
      policy.bands.find((b) => b.key === 'negative') ??
      [...policy.bands].sort((a, b) => a.minScore - b.minScore)[0] ??
      null
    );
  }
  return (
    [...policy.bands].sort((a, b) => b.minScore - a.minScore).find((b) => score >= b.minScore) ?? null
  );
}

/**
 * Score a set of signal results against the policy.
 *
 * Scoring is deliberately simple and total: sum the weights of what fired, clamp
 * to 0-100, pick the highest band whose threshold is met. Simple matters here —
 * a score a salesperson cannot reproduce on paper is a score they will not
 * trust, and an elaborate model would buy accuracy nobody can audit.
 */
export function scoreSignals(
  policy: QualificationPolicy,
  results: SignalResult[],
): {
  score: number;
  band: QualificationBand | null;
  fired: SignalResult[];
  handoff: { requested: boolean; reason: string | null };
} {
  const fired = results.filter((r) => r.matched);
  const raw = fired.reduce((sum, r) => sum + r.weight, 0);

  // A negative total is clamped to 0 for display but keeps its own band: the
  // difference between "we know they said no" and "we know nothing" matters.
  const negative = raw < 0;
  const score = Math.max(0, Math.min(100, raw));

  const band = bandForScore(policy, score, negative);

  const handoffSignal = fired.find((r) => policy.handoffSignals.includes(r.key));
  const byScore = policy.handoffAtScore != null && !negative && score >= policy.handoffAtScore;

  return {
    score,
    band,
    fired,
    handoff: {
      requested: !!handoffSignal || byScore || !!band?.requestHandoff,
      reason: handoffSignal
        ? `“${handoffSignal.label}” needs a person.`
        : byScore
          ? `Score ${score} is at or above the escalation threshold of ${policy.handoffAtScore}.`
          : band?.requestHandoff
            ? `The “${band.label}” band asks for a person.`
            : null,
    },
  };
}

/**
 * Deterministic phrase matching — the no-provider path.
 *
 * Word-boundary anchored so "return this" does not fire inside "returned to the
 * shelf", and so a signal keyed on "urgent" is not matched by "insurgent".
 */
export function matchSignals(policy: QualificationPolicy, text: string): SignalResult[] {
  const haystack = text.toLowerCase();
  return policy.signals.map((sig) => {
    const hit = sig.phrases.find((p) => {
      const needle = p.toLowerCase().trim();
      if (!needle) return false;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(haystack);
    });
    return {
      key: sig.key,
      label: sig.label,
      weight: sig.weight,
      matched: !!hit,
      ...(hit ? { evidence: excerpt(text, hit) } : {}),
    };
  });
}

/** A short window of the original text around a match, for the "why" panel. */
function excerpt(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return needle;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + needle.length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
