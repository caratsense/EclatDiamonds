/**
 * Pure helpers for the EzAttendancePRO import (docs/modules/06-attendance.md).
 * No database here, so the parsing rules are testable on their own.
 */

/**
 * RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines (the
 * EzAttendance address column has all three). A UTF-8 BOM is dropped; blank
 * lines are skipped. Returns one object per data row keyed by the trimmed header.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const data = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!data.length) return [];
  const header = data[0].map((h) => h.trim());
  return data.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Case/space-insensitive key for matching master names ("Head  office" == "HEAD OFFICE"). */
export function normKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Display spelling for a master row: each word capitalised, the rest lowered,
 * except short all-caps tokens (HOD, QC) which are acronyms.
 */
export function titleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z0-9]+/g, (w) =>
      /^[A-Z]{2,3}$/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase(),
    );
}

/** DD/MM/YYYY -> UTC-midnight Date. Blank or 01/01/1900 = missing (null). Invalid = 'invalid'. */
export function parseDmy(s: string | undefined): Date | null | 'invalid' {
  const v = (s ?? '').trim();
  if (!v || v === '-' || v === '01/01/1900') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) return 'invalid';
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : 'invalid';
}

/** "HH:MM" -> minutes, or null for "-"/blank/garbage. */
export function parseClock(s: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

const DOMAIN_TYPOS = /@(gamil|gmial|gmai|gnail|gmal|yahooo|yaho|hotmial|hotmal|outlok)\./i;

/** Why an email looks wrong (reported, never "fixed"), or null. */
export function emailIssue(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'not a valid email address';
  if (DOMAIN_TYPOS.test(email)) return 'domain looks like a typo';
  return null;
}

/** Default shift per EzAttendance code, seeded into a store when missing. */
export const DEFAULT_SHIFTS: Record<
  string,
  { name: string; startTime: string; endTime: string; isFlexible: boolean }
> = {
  S: {
    name: 'Store (S)',
    startTime: '11:00',
    endTime: '20:00',
    isFlexible: false,
  },
  G: {
    name: 'General (G)',
    startTime: '09:30',
    endTime: '18:30',
    isFlexible: false,
  },
  '6HR': {
    name: 'Six hours (6HR)',
    startTime: '10:00',
    endTime: '16:00',
    isFlexible: false,
  },
  F: {
    name: 'Flexible (F)',
    startTime: '05:00',
    endTime: '23:00',
    isFlexible: true,
  },
};

/** EzAttendance leave type letter -> LeaveType. */
export const LEAVE_TYPE_MAP: Record<string, 'earned' | 'week_off_leave'> = {
  E: 'earned',
  K: 'week_off_leave',
};

/** Last 10 digits of a phone, the same rule OTP login matches on. */
export function last10(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
