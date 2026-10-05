/**
 * The daily-report questionnaire and the parsing behind it.
 *
 * Pure functions on purpose: this is where a typo becomes a wrong number in a
 * revenue column, so it must be testable without a database or WhatsApp.
 */

/** A skip: the field is left at 0 / null rather than answered. */
const SKIP_WORDS = new Set(['skip', 'none', 'nil', 'na', 'n/a', '-', '0']);

export function isSkip(raw: string): boolean {
  return SKIP_WORDS.has(raw.trim().toLowerCase());
}

/**
 * Parse an amount the way a jeweller actually types it: "450000", "4,50,000",
 * "4.5L", "₹4.5 lakh", "450k", "1.2cr".
 *
 * Indian digit grouping (2,2,3) makes comma-stripping mandatory rather than
 * cosmetic — "4,50,000" is not parseable as a plain float. Returns null when the
 * text is not a number, so the caller can re-ask instead of storing a guess.
 */
export function parseAmount(raw: string): number | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[₹,\s]/g, '')
    .replace(/^rs\.?|^inr/, '');
  if (!s) return null;

  const m = s.match(/^(\d+(?:\.\d+)?)(l|lac|lakh|lakhs|cr|crore|crores|k|thousand)?$/);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;

  switch (m[2]) {
    case 'l':
    case 'lac':
    case 'lakh':
    case 'lakhs':
      return n * 100_000;
    case 'cr':
    case 'crore':
    case 'crores':
      return n * 10_000_000;
    case 'k':
    case 'thousand':
      return n * 1_000;
    default:
      return n;
  }
}

/** Whole-number counts (walk-ins, enquiries). Rejects decimals and negatives. */
export function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Weights allow decimals ("12.5 g", "12.5gm"). */
export function parseWeight(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[,\s]/g, '').replace(/(gm|gms|g|grams|gram)$/, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The sheet's own headings, used verbatim.
 *
 * A reporter filling this in over WhatsApp is filling in the same document
 * they sign at close of day; matching its language is what lets them check one
 * against the other.
 */
export const FOOTFALL = 'Footfall';
export const TABLE_A = 'Table A — Counter sale';
export const TABLE_B = 'Table B — Customised sale';
export const REMARK = 'Remark';

export interface DsrField {
  /** Matches the DailyReport column. */
  key: string;
  prompt: string;
  kind: 'count' | 'amount' | 'weight' | 'text';
  /** Optional fields store null when skipped; required ones store 0. */
  optional?: boolean;
  /**
   * Ask this only when the answers so far make it meaningful.
   *
   * A follow-up whose premise failed is worse than a wasted question: it
   * invites an answer that contradicts the thing it depends on. A real report
   * filed on 4 Oct read "Advance received: ₹0" and "UPI ₹3,00,000", because
   * the split was asked after the advance came back zero and the number was
   * taken at face value.
   *
   * Absent means always ask.
   */
  askWhen?: (draft: DsrDraft) => boolean;
  /**
   * The sheet heading this field sits under, announced once on entry.
   *
   * Load-bearing rather than decorative: "Cash?" is asked TWICE — once for
   * counter sale and once for customised sale — and without the heading there
   * is no way for the reporter to tell which table they are filling. The two
   * are reconciled separately by the store, so a number entered under the
   * wrong one is not a rounding error.
   */
  section?: string;
}

/** Answers collected so far. `null` is a skipped optional field. */
export type DsrDraft = Record<string, number | null | string | undefined>;

/** A field's answer as a number, treating skipped and unasked alike as zero. */
function amount(draft: DsrDraft, key: string): number {
  const v = draft[key];
  return typeof v === 'number' ? v : 0;
}

/**
 * Money taken across both tables. Reporting only — the per-table checks
 * reconcile against their own totals, because the store does.
 */
export function moneyReceived(draft: DsrDraft): number {
  return amount(draft, 'deliveredBilled') + amount(draft, 'advanceReceived');
}

/**
 * Question order mirrors how the report is read aloud at close: footfall, then
 * what was sold, then how it was paid for, then old gold.
 */
export const DSR_FIELDS: DsrField[] = [
  /* ------------------------------------------------------------- footfall */
  { key: 'walkIns', prompt: 'How many *walk-ins* today?', kind: 'count', section: FOOTFALL },
  { key: 'seriousEnquiries', prompt: 'How many *serious enquiries*?', kind: 'count' },
  { key: 'conversions', prompt: 'How many *converted* into a sale?', kind: 'count' },

  /* ----------------------------------------------- TABLE A — counter sale */
  { key: 'deliveredBilled', prompt: '*Sale value* at the counter today?', kind: 'amount', section: TABLE_A },
  // The payment split for Table A. Skipped entirely when nothing was sold at
  // the counter, rather than asked five times to be told zero five times.
  { key: 'cash', prompt: 'Of that — *cash*?', kind: 'amount', askWhen: (d) => amount(d, 'deliveredBilled') > 0 },
  { key: 'card', prompt: 'Of that — *card*?', kind: 'amount', askWhen: (d) => amount(d, 'deliveredBilled') > 0 },
  { key: 'upi', prompt: 'Of that — *UPI*?', kind: 'amount', askWhen: (d) => amount(d, 'deliveredBilled') > 0 },
  {
    key: 'oldGoldWtG',
    prompt: '*Old gold* taken against it (grams)?',
    kind: 'weight',
    optional: true,
    askWhen: (d) => amount(d, 'deliveredBilled') > 0,
  },
  // Valuing gold that was never taken is the same mistake one question later.
  {
    key: 'oldGoldValue',
    prompt: 'What was that old gold *worth*?',
    kind: 'amount',
    optional: true,
    askWhen: (d) => amount(d, 'oldGoldWtG') > 0,
  },

  /* -------------------------------------------- TABLE B — customised sale */
  { key: 'bookingsNew', prompt: '*Booking value* taken today?', kind: 'amount', section: TABLE_B },
  { key: 'bookingsOpen', prompt: '*Open bookings* still outstanding?', kind: 'amount' },
  { key: 'bookingsClosed', prompt: '*Bookings closed* — sale completed?', kind: 'amount' },
  // "Closing Booking" on the sheet is DERIVED (see reporting.service), so it is
  // deliberately not asked. Asking for a number the system calculates invites a
  // reporter's arithmetic to disagree with the sheet's.
  { key: 'advanceReceived', prompt: '*Amount received* against bookings?', kind: 'amount' },
  // Table B's own payment split, kept separate from Table A because the store
  // reconciles the two tables separately and a merged total cannot be checked
  // against either.
  { key: 'customCash', prompt: 'Of that — *cash*?', kind: 'amount', askWhen: (d) => amount(d, 'advanceReceived') > 0 },
  { key: 'customCard', prompt: 'Of that — *card*?', kind: 'amount', askWhen: (d) => amount(d, 'advanceReceived') > 0 },
  { key: 'customUpi', prompt: 'Of that — *UPI*?', kind: 'amount', askWhen: (d) => amount(d, 'advanceReceived') > 0 },
  {
    key: 'customBankTransfer',
    prompt: 'Of that — *bank transfer*?',
    kind: 'amount',
    askWhen: (d) => amount(d, 'advanceReceived') > 0,
  },
  {
    key: 'customGoldWtG',
    prompt: '*Old gold* taken against bookings (grams)?',
    kind: 'weight',
    optional: true,
    askWhen: (d) => amount(d, 'advanceReceived') > 0,
  },
  {
    key: 'customGoldValue',
    prompt: 'What was that gold *worth*?',
    kind: 'amount',
    optional: true,
    askWhen: (d) => amount(d, 'customGoldWtG') > 0,
  },

  /* --------------------------------------------------------------- remark */
  { key: 'remark', prompt: 'Anything to *note* about the day?', kind: 'text', optional: true, section: REMARK },
];

/**
 * Which sheet heading a field sits under.
 *
 * Only the first field of each block carries `section`, so this walks back to
 * the nearest one. Keeping the heading on a single field means inserting a
 * question into the middle of a block cannot accidentally restate the heading
 * or, worse, silently start a new one.
 */
export function sectionOf(field: DsrField, index: number): string | null {
  if (field.section) return field.section;
  for (let i = Math.min(index, DSR_FIELDS.length - 1); i >= 0; i -= 1) {
    const s = DSR_FIELDS[i].section;
    if (s) return s;
  }
  return null;
}

/** Is this question meaningful given what has been answered so far? */
export function shouldAsk(field: DsrField, draft: DsrDraft): boolean {
  return field.askWhen ? field.askWhen(draft) : true;
}

/**
 * The next question to put, skipping any whose premise has failed.
 *
 * Returns `DSR_FIELDS.length` when nothing is left to ask, which the caller
 * reads as "go to the summary".
 */
export function nextAskableStep(draft: DsrDraft, from: number): number {
  let i = Math.max(0, from);
  while (i < DSR_FIELDS.length && !shouldAsk(DSR_FIELDS[i], draft)) i += 1;
  return i;
}

/**
 * Fill in everything the skip logic passed over.
 *
 * A question that was never asked still needs a value, or the report would
 * carry nulls that look like missing data rather than a genuine zero. Optional
 * fields stay null — "no old gold" is honestly nothing, not zero grams.
 */
export function fillSkipped(draft: DsrDraft): DsrDraft {
  const out: DsrDraft = { ...draft };
  for (const f of DSR_FIELDS) {
    if (out[f.key] === undefined && !shouldAsk(f, out)) out[f.key] = f.optional ? null : 0;
  }
  return out;
}

/**
 * Does the payment split exceed what was actually taken?
 *
 * Returns the complaint to send back, or null when the numbers are coherent.
 * Checked at the END of the split rather than per answer, because cash alone
 * exceeding the total is only wrong once card and UPI are known to be zero.
 */
export function paymentSplitError(draft: DsrDraft, table: 'A' | 'B'): string | null {
  const isA = table === 'A';
  // Each table reconciles against its OWN total. The store checks them
  // separately, so a merged comparison would let an overstatement in one hide
  // behind headroom in the other.
  const againstKey = isA ? 'deliveredBilled' : 'advanceReceived';
  const against = amount(draft, againstKey);
  const parts = isA
    ? ['cash', 'card', 'upi', 'oldGoldValue']
    : ['customCash', 'customCard', 'customUpi', 'customBankTransfer', 'customGoldValue'];
  const split = parts.reduce((sum, k) => sum + amount(draft, k), 0);
  if (split <= against) return null;

  const label = isA ? 'the counter sale' : 'the amount received against bookings';
  return (
    `That adds up to ${inr(split)} in payments, but ${label} was ${inr(against)}. ` +
    `Please check the last figure.`
  );
}

/** Parse one answer for a field. `null` means "could not read it — re-ask". */
export function parseField(field: DsrField, raw: string): number | string | null {
  switch (field.kind) {
    case 'count':
      return parseCount(raw);
    case 'weight':
      return parseWeight(raw);
    case 'text':
      // Kept as typed, trimmed. There is nothing to validate about a remark,
      // and rejecting one would lose the only part of the report a person
      // wrote in their own words.
      return raw.trim() || null;
    default:
      return parseAmount(raw);
  }
}

/** Indian-format money for confirmations: 450000 -> "₹4,50,000". */
export function inr(n: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;
}

/**
 * How far back a report may be filed. Long enough to cover a forgotten Friday or
 * a weekend, short enough that nobody quietly rewrites last month's numbers.
 */
export const MAX_BACKDATE_DAYS = 14;

/** "2026-08-21" from a @db.Date-style UTC-midnight Date. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Shift a UTC-midnight date by whole days without tripping over DST. */
function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Read the date a report is being filed for, relative to the store's own today.
 *
 * Accepts `today`, `yesterday`, `21/8`, `21-08`, `21/08/2026`. A bare day/month
 * that would land in the future is read as last year's — on 2 Jan, "28/12" means
 * five days ago, not eleven months away.
 *
 * Returns null when it cannot be read, is in the future, or is further back than
 * MAX_BACKDATE_DAYS — the caller must re-ask rather than guess at a date that
 * decides which day's revenue gets overwritten.
 */
export function parseReportDate(raw: string, today: Date): Date | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === 'today') return today;
  if (s === 'yesterday') return addDays(today, -1);

  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/);
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  let year: number;
  if (m[3]) {
    year = Number(m[3]);
    if (year < 100) year += 2000;
  } else {
    year = today.getUTCFullYear();
  }

  let candidate = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible dates (31/02 rolls over into March).
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;

  // Bare "28/12" typed in early January means last December.
  if (!m[3] && candidate > today) {
    candidate = new Date(Date.UTC(year - 1, month - 1, day));
  }

  if (candidate > today) return null;
  if (candidate < addDays(today, -MAX_BACKDATE_DAYS)) return null;
  return candidate;
}

/** "21 Aug 2026" — unambiguous in a way 21/08 vs 08/21 is not. */
export function formatDateLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** ISO date key used inside the session draft (see WhatsAppConversationService). */
export const DRAFT_DATE_KEY = '_reportDate';

export { iso as isoDate, addDays as addDaysUtc };

/**
 * The question text, with the hint that a field can be skipped.
 *
 * The counter numbers the questions ACTUALLY being asked, not positions in the
 * full list. Once questions can be skipped, "7/10" followed by the summary
 * reads as three lost answers; counting what is really being put makes the
 * last question say so.
 *
 * The total is the best estimate from what is known now — a later answer can
 * still open or close a follow-up — so it can move. That is honest: the
 * alternative is a fixed denominator that is wrong for every report with a
 * skip in it.
 */
export function promptFor(field: DsrField, index: number, draft: DsrDraft = {}): string {
  let asked = 0;
  let total = 0;
  for (let i = 0; i < DSR_FIELDS.length; i += 1) {
    if (!shouldAsk(DSR_FIELDS[i], draft)) continue;
    total += 1;
    if (i <= index) asked += 1;
  }
  const counter = `${Math.max(1, asked)}/${Math.max(total, asked)}`;
  const hint = field.optional ? ' (reply *skip* if none)' : ' (reply *0* if none)';
  return `${counter} — ${field.prompt}${hint}`;
}

/** The summary shown before anything is written. */
export function summarise(
  // `DsrDraft`, not `Record<string, number | null>`: the draft really does hold
  // a string under DRAFT_DATE_KEY and under `remark`, and fields skipped by
  // `askWhen` are absent until `fillSkipped` runs.
  draft: DsrDraft,
  storeName: string,
  dateLabel: string,
): string {
  const v = (k: string) => Number(draft[k] ?? 0);
  const money = (k: string) => inr(v(k));

  /*
   * Laid out as the SHEET is, not as the questions were asked.
   *
   * This is the last thing a reporter sees before committing the day, and the
   * document it becomes has two tables that the store reconciles separately.
   * A flat list of figures cannot be checked against either; this can be read
   * straight down against the printed sheet.
   */
  const lines = [
    `*${storeName}* — ${dateLabel}`,
    '',
    `Walk-ins ${v('walkIns')} · Enquiries ${v('seriousEnquiries')} · Converted ${v('conversions')}`,
  ];

  lines.push('', '*Counter sale*', `Sale value: ${money('deliveredBilled')}`);
  if (v('deliveredBilled') > 0) {
    lines.push(`Cash ${money('cash')} · Card ${money('card')} · UPI ${money('upi')}`);
    if (draft.oldGoldWtG != null) {
      lines.push(`Old gold ${draft.oldGoldWtG} g · ${money('oldGoldValue')}`);
    }
  }

  lines.push(
    '',
    '*Customised sale*',
    `Booked today: ${money('bookingsNew')}`,
    `Open ${money('bookingsOpen')} · Closed ${money('bookingsClosed')}`,
    `Received: ${money('advanceReceived')}`,
  );
  if (v('advanceReceived') > 0) {
    lines.push(
      `Cash ${money('customCash')} · Card ${money('customCard')} · UPI ${money('customUpi')}`,
      `Bank transfer ${money('customBankTransfer')}`,
    );
    if (draft.customGoldWtG != null) {
      lines.push(`Old gold ${draft.customGoldWtG} g · ${money('customGoldValue')}`);
    }
  }

  if (typeof draft.remark === 'string' && draft.remark.trim()) {
    lines.push('', `_${draft.remark.trim()}_`);
  }

  lines.push(
    '',
    'Reply *YES* to submit, *CANCEL* to discard,',
    'or *DATE 20/08* if this is for another day.',
  );
  return lines.join('\n');
}
