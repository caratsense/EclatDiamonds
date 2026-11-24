/**
 * When a message happened, in the words WhatsApp uses.
 *
 * ## Why this is a file and not three `toLocaleTimeString` calls
 *
 * The inbox printed a bare clock time — "12:25 PM" — against every thread and
 * every bubble, with no date anywhere. A thread last touched in October read
 * exactly like one last touched an hour ago, so the screen could not answer the
 * one question somebody opens it to ask: when did we last speak to this
 * customer? (Client, 23 Nov: "where time is mentioned add dates so that we know
 * when we last interacted with that customer.")
 *
 * ## Why the BRANCH's clock decides the day
 *
 * "Is this today" is wrong for an hour or more every single day if it is asked
 * of the wrong clock, and nobody notices because it is right the other
 * twenty-three. A message sent at 00:30 in Surat is 19:00 the PREVIOUS day in
 * UTC, which is what the server's clock would say and what `new Date(iso)`
 * reads on a laptop roaming in another zone. So every function here takes the
 * zone of the branch that owns the thread, the same `Store.timezone` the
 * attendance and reporting code anchors its business days to
 * (`backend/src/common/tz.util.ts`), and the comparison is done on calendar
 * days IN THAT ZONE rather than on elapsed milliseconds.
 *
 * ## Why `now` is a parameter
 *
 * Because that is the only way to test the boundary. 23:59 and 00:01 are two
 * minutes apart and belong to different days; a rule that cannot be tested at
 * those two instants is a rule nobody has checked.
 */

/**
 * Zone used when a thread has no branch yet — an ad click nobody has routed.
 *
 * The same fallback and for the same reason as `DEFAULT_TZ` in the server's
 * `tz.util`: a missing or mistyped zone must degrade to the chain's own clock
 * rather than throw while somebody is reading an inbox.
 */
export const DEFAULT_BRANCH_TZ = "Asia/Kolkata";

/** Normalise a stored zone to one this runtime can actually format in. */
export function branchZone(timezone: string | null | undefined): string {
  if (!timezone) return DEFAULT_BRANCH_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_BRANCH_TZ;
  }
}

export interface BranchTimeOptions {
  /** `Store.timezone` of the branch that owns the thread. */
  timeZone?: string | null;
  /** Injected so "is this today" can be tested at 23:59 and at 00:01. */
  now?: Date;
  /** Defaults to the reader's own locale, as everywhere else in the app. */
  locale?: string;
}

/** `Intl.DateTimeFormat` is expensive to construct; one per zone is enough. */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatterFor(tz: string): Intl.DateTimeFormat {
  const cached = dayFormatters.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dayFormatters.set(tz, fmt);
  return fmt;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The calendar day an instant falls on in a given zone, as "YYYY-MM-DD".
 *
 * A string rather than a Date because its only two jobs are equality — has the
 * day changed between these two bubbles? — and ordering, and both are exact on
 * a zero-padded key. Empty for an unparseable stamp, which compares unequal to
 * nothing and so cannot invent a separator.
 */
export function zonedDayKey(
  iso: string | null | undefined,
  timezone?: string | null,
): string {
  const d = parse(iso);
  if (!d) return "";
  const parts: Record<string, string> = {};
  for (const p of dayFormatterFor(branchZone(timezone)).formatToParts(d)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Days since the Unix epoch for a "YYYY-MM-DD" key. DST-proof: no clocks involved. */
function dayNumber(key: string): number | null {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export type DayBucket = "today" | "yesterday" | "this_week" | "older";

/**
 * How near this instant is, counted in whole branch-local days.
 *
 * `this_week` stops at six days, not seven: seven days ago is the SAME weekday
 * as today, so "Monday" on a Monday would name two different days with one
 * word. Anything that old gets a date instead.
 *
 * A stamp in the future reads as today. That happens — a provider clock running
 * a few seconds ahead — and "tomorrow" is never a useful thing to tell somebody
 * about a message they are looking at.
 */
export function dayBucket(
  iso: string | null | undefined,
  opts: BranchTimeOptions = {},
): DayBucket | null {
  const then = dayNumber(zonedDayKey(iso, opts.timeZone));
  const today = dayNumber(zonedDayKey((opts.now ?? new Date()).toISOString(), opts.timeZone));
  if (then === null || today === null) return null;
  const diff = today - then;
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return "this_week";
  return "older";
}

/**
 * The clock time on a bubble: "9:41 PM".
 *
 * `hour: "numeric"` rather than `"2-digit"` — WhatsApp writes 9:41 PM, not
 * 09:41 PM, and the client asked for the times "just as real whatsapp does".
 */
export function messageTime(
  iso: string | null | undefined,
  opts: BranchTimeOptions = {},
): string {
  const d = parse(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat(opts.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: branchZone(opts.timeZone),
  }).format(d);
}

function weekdayName(d: Date, opts: BranchTimeOptions): string {
  return new Intl.DateTimeFormat(opts.locale, {
    weekday: "long",
    timeZone: branchZone(opts.timeZone),
  }).format(d);
}

function numericDate(d: Date, opts: BranchTimeOptions): string {
  return new Intl.DateTimeFormat(opts.locale, {
    timeZone: branchZone(opts.timeZone),
  }).format(d);
}

/**
 * The stamp beside a thread in the list: "12:25 PM", "Yesterday", "Wednesday",
 * "10/14/2026" — the four shapes in the client's own WhatsApp screenshot.
 */
export function threadStamp(
  iso: string | null | undefined,
  opts: BranchTimeOptions = {},
): string {
  const d = parse(iso);
  const bucket = dayBucket(iso, opts);
  if (!d || !bucket) return "";
  if (bucket === "today") return messageTime(iso, opts);
  if (bucket === "yesterday") return "Yesterday";
  if (bucket === "this_week") return weekdayName(d, opts);
  return numericDate(d, opts);
}

/**
 * The pill between two days inside a thread.
 *
 * This is what stops a two-hundred-message thread being undateable: every
 * bubble carries a time, and the day it belongs to is stated once, where it
 * changes. Rendered through the pill's `uppercase`, so "Today" reads as TODAY.
 */
export function daySeparator(
  iso: string | null | undefined,
  opts: BranchTimeOptions = {},
): string {
  const d = parse(iso);
  const bucket = dayBucket(iso, opts);
  if (!d || !bucket) return "";
  if (bucket === "today") return "Today";
  if (bucket === "yesterday") return "Yesterday";
  if (bucket === "this_week") return weekdayName(d, opts);
  return numericDate(d, opts);
}

/**
 * When we last heard from this customer, as a sentence: "today at 12:25 PM",
 * "yesterday at 9:41 PM", "Wednesday at 3:02 PM", "10/14/2026 at 11:05 AM".
 *
 * The one the client asked for in so many words — "only if they are of today
 * then it should mention today at so and so time" — because the thread header
 * said "Last wrote 12:25 PM" whether that was this morning or in August.
 */
export function lastInteraction(
  iso: string | null | undefined,
  opts: BranchTimeOptions = {},
): string {
  const d = parse(iso);
  const bucket = dayBucket(iso, opts);
  if (!d || !bucket) return "";
  const day =
    bucket === "today"
      ? "today"
      : bucket === "yesterday"
        ? "yesterday"
        : bucket === "this_week"
          ? weekdayName(d, opts)
          : numericDate(d, opts);
  return `${day} at ${messageTime(iso, opts)}`;
}
