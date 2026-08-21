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

export interface DsrField {
  /** Matches the DailyReport column. */
  key: string;
  prompt: string;
  kind: 'count' | 'amount' | 'weight';
  /** Optional fields store null when skipped; required ones store 0. */
  optional?: boolean;
}

/**
 * Question order mirrors how the report is read aloud at close: footfall, then
 * what was sold, then how it was paid for, then old gold.
 */
export const DSR_FIELDS: DsrField[] = [
  { key: 'walkIns', prompt: 'How many *walk-ins* today?', kind: 'count' },
  { key: 'seriousEnquiries', prompt: 'How many *serious enquiries*?', kind: 'count' },
  { key: 'deliveredBilled', prompt: '*Delivered & billed* today?', kind: 'amount' },
  { key: 'bookingsNew', prompt: '*New bookings* (approx)?', kind: 'amount' },
  { key: 'advanceReceived', prompt: '*Advance received*?', kind: 'amount' },
  { key: 'cash', prompt: 'Of that — *cash*?', kind: 'amount' },
  { key: 'card', prompt: '*Card*?', kind: 'amount' },
  { key: 'upi', prompt: '*UPI*?', kind: 'amount' },
  { key: 'oldGoldWtG', prompt: '*Old gold* taken (grams)?', kind: 'weight', optional: true },
  { key: 'oldGoldValue', prompt: 'Old gold *value*?', kind: 'amount', optional: true },
];

/** Parse one answer for a field. `null` means "could not read it — re-ask". */
export function parseField(field: DsrField, raw: string): number | null {
  switch (field.kind) {
    case 'count':
      return parseCount(raw);
    case 'weight':
      return parseWeight(raw);
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

/** The question text, with the hint that a field can be skipped. */
export function promptFor(field: DsrField, index: number): string {
  const counter = `${index + 1}/${DSR_FIELDS.length}`;
  const hint = field.optional ? ' (reply *skip* if none)' : ' (reply *0* if none)';
  return `${counter} — ${field.prompt}${hint}`;
}

/** The summary shown before anything is written. */
export function summarise(
  draft: Record<string, number | null>,
  storeName: string,
  dateLabel: string,
): string {
  const v = (k: string) => Number(draft[k] ?? 0);
  const lines = [
    `*${storeName}* — ${dateLabel}`,
    '',
    `Walk-ins: ${v('walkIns')}   Serious enquiries: ${v('seriousEnquiries')}`,
    `Delivered & billed: ${inr(v('deliveredBilled'))}`,
    `New bookings: ${inr(v('bookingsNew'))}`,
    `Advance received: ${inr(v('advanceReceived'))}`,
    `Cash ${inr(v('cash'))} · Card ${inr(v('card'))} · UPI ${inr(v('upi'))}`,
  ];
  if (draft.oldGoldWtG != null || draft.oldGoldValue != null) {
    lines.push(`Old gold: ${draft.oldGoldWtG ?? 0} g · ${inr(Number(draft.oldGoldValue ?? 0))}`);
  }
  lines.push(
    '',
    'Reply *YES* to submit, *CANCEL* to discard,',
    'or *DATE 20/08* if this is for another day.',
  );
  return lines.join('\n');
}
