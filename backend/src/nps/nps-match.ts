/**
 * Matching a form submission to a customer and a visit.
 *
 * The rule the client set, and the reason for every line here: **never match
 * on name alone.** The supplied workbook proves why. One of its two real
 * responses is from "Ronit Gurav" on 8888155700, and the walk-in register row
 * for that exact number is named "VIKAS JEWELLERS". Either is plausible — a
 * shop's phone, a relative, a mis-keyed register entry — and a name-based
 * matcher would have confidently attached the feedback to the wrong person
 * while a number-based one correctly flags it for a human.
 */

/** A visit a response might belong to. */
export interface MatchCandidate {
  checkInId: string;
  partyId: string | null;
  /** The visit's own moment, used to pick the nearest preceding visit. */
  visitAt: Date;
  customerName: string | null;
}

export type MatchState = 'matched' | 'unmatched' | 'ambiguous';

export interface MatchResult {
  state: MatchState;
  checkInId: string | null;
  partyId: string | null;
  note: string;
}

/**
 * A phone number as WhatsApp and our own records spell it: digits only, with
 * the country code, no plus.
 *
 * The float case is not hypothetical. Google Sheets and Excel hand numbers
 * back as doubles, so a cell reading 8888155700 arrives as `8888155700.0`;
 * naive `String(v)` then yields "8888155700.0" and stripping non-digits gives
 * an ELEVEN digit number that matches nothing and silently imports as
 * unmatched. That bug cost a reconciliation pass before it was spotted.
 */
export function normaliseNpsPhone(value: unknown): string | null {
  if (value == null) return null;
  let raw = value;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    raw = Number.isInteger(raw) ? String(raw) : String(raw).replace(/\.0+$/, '');
  }
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1);
  // An international number we cannot reason about is kept as-is rather than
  // mangled into an Indian one — walk-ins may be foreign customers.
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return null;
}

/**
 * Which visit does this submission belong to?
 *
 * Repeat visits are the hard case and the common one: a customer who came in
 * three times has three candidate visits on one number. The rule is the
 * nearest visit AT OR BEFORE the submission — you cannot give feedback on a
 * visit that has not happened — and if two visits sit equally close, nobody
 * can tell them apart and it is handed to a person.
 */
export function matchNpsResponse(
  submittedAt: Date,
  phoneE164: string | null,
  candidates: MatchCandidate[],
): MatchResult {
  if (!phoneE164) {
    return {
      state: 'unmatched',
      checkInId: null,
      partyId: null,
      note: 'No usable phone number on the submission — matching by name is not allowed.',
    };
  }
  if (!candidates.length) {
    return {
      state: 'unmatched',
      checkInId: null,
      partyId: null,
      note: `No visit recorded for ${phoneE164}.`,
    };
  }

  const prior = candidates
    .filter((c) => c.visitAt <= submittedAt)
    .sort((a, b) => b.visitAt.getTime() - a.visitAt.getTime());

  if (!prior.length) {
    // Every visit on this number happened AFTER the form was submitted. That is
    // not a match; it is a clock or a data problem, and saying so is better
    // than attaching feedback to a visit it cannot describe.
    return {
      state: 'ambiguous',
      checkInId: null,
      partyId: null,
      note: `${candidates.length} visit(s) on ${phoneE164}, all after this submission.`,
    };
  }

  const [best, next] = prior;
  if (next && next.visitAt.getTime() === best.visitAt.getTime()) {
    return {
      state: 'ambiguous',
      checkInId: null,
      partyId: null,
      note: `Two visits on ${phoneE164} at the same moment — cannot tell which this answers.`,
    };
  }

  return {
    state: 'matched',
    checkInId: best.checkInId,
    partyId: best.partyId,
    note:
      prior.length > 1
        ? `Nearest of ${prior.length} prior visits on ${phoneE164}.`
        : `Matched on ${phoneE164}.`,
  };
}

/**
 * 0..10 out of whatever the client's form says today.
 *
 * Best-effort and stored BESIDE the original text, never instead of it: the
 * form's option wording is the client's and changes without telling us, so a
 * parse that fails must cost a number in an average, not a lost response.
 */
export function parseRecommendScore(answer: unknown): number | null {
  if (answer == null) return null;
  if (typeof answer === 'number' && Number.isFinite(answer)) {
    const n = Math.round(answer);
    return n >= 0 && n <= 10 ? n : null;
  }
  const m = String(answer).trim().match(/^(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 10 ? n : null;
}

/**
 * The identity of a source row, so re-importing the sheet updates instead of
 * duplicating. Submission time plus number is what the sheet itself can
 * guarantee; Google does not expose a row id through the export.
 */
export function npsImportKey(
  organisationId: string,
  submittedAt: Date,
  phoneE164: string | null,
  kind: 'response' | 'followup' = 'response',
): string {
  return [organisationId, kind, submittedAt.toISOString(), phoneE164 ?? 'nophone'].join('|');
}
