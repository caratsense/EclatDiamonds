/**
 * CaratOS import — Customer row transform + validation (pure, no I/O).
 *
 * Turns a mapped source row into a validated canonical customer and a list of
 * issues. NEVER fabricates data: a missing optional field stays empty; only
 * `name` is required. Phone is validated only if present, using the SAME
 * Indian-mobile rule as the rest of the app (no bespoke regex). Rows are never
 * silently dropped — an invalid row is returned with `ok: false` + reasons.
 */

import { normalizeIndianMobile } from '../../common/contact.util';

export interface MappedCustomer {
  name?: string;
  code?: string;
  phone?: string;
  email?: string;
  city?: string;
  gstin?: string;
  birthday?: string;
  anniversary?: string;
}

export interface CustomerIssue {
  /** '' when the issue is row-level rather than field-level. */
  field: string;
  code: 'missing_required' | 'invalid_phone' | 'invalid_email' | 'invalid_gstin' | 'invalid_date';
  message: string;
}

export interface CustomerRowResult {
  ok: boolean;
  /** Cleaned values ready to persist (only when ok). */
  value?: {
    name: string;
    code: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    gstin: string | null;
    birthday: string | null;
    anniversary: string | null;
  };
  issues: CustomerIssue[];
  /** True when a real problem forces a warning but not a rejection (kept, flagged). */
  warnings: CustomerIssue[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// GSTIN: 15 chars — 2 state digits, 10 PAN, 1 entity, 'Z', 1 checksum. Format-only.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const clean = (v: string | undefined): string => (v ?? '').trim();

function optionalIsoDate(
  field: 'birthday' | 'anniversary',
  value: string | undefined,
  warnings: CustomerIssue[],
): string | null {
  const raw = clean(value);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    warnings.push({
      field,
      code: 'invalid_date',
      message: `"${raw}" must use YYYY-MM-DD — imported without ${field}`,
    });
    return null;
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    warnings.push({
      field,
      code: 'invalid_date',
      message: `"${raw}" is not a real calendar date — imported without ${field}`,
    });
    return null;
  }
  return raw;
}

/**
 * Validate + normalise one mapped row. `name` is the only hard requirement; a
 * bad phone/email/GSTIN is a WARNING (the row is still imported, flagged) rather
 * than a rejection, because historical records legitimately have gaps — but the
 * gaps are reported, never hidden.
 */
export function mapCustomerRow(row: MappedCustomer): CustomerRowResult {
  const issues: CustomerIssue[] = [];
  const warnings: CustomerIssue[] = [];

  const name = clean(row.name);
  if (!name) {
    issues.push({ field: 'name', code: 'missing_required', message: 'Customer name is required' });
  }

  let phone: string | null = null;
  const rawPhone = clean(row.phone);
  if (rawPhone) {
    const norm = normalizeIndianMobile(rawPhone);
    if (norm) phone = norm;
    else warnings.push({ field: 'phone', code: 'invalid_phone', message: `"${rawPhone}" is not a valid Indian mobile — imported without phone` });
  }

  let email: string | null = null;
  const rawEmail = clean(row.email).toLowerCase();
  if (rawEmail) {
    if (EMAIL_RE.test(rawEmail)) email = rawEmail;
    else warnings.push({ field: 'email', code: 'invalid_email', message: `"${rawEmail}" is not a valid email — imported without email` });
  }

  let gstin: string | null = null;
  const rawGstin = clean(row.gstin).toUpperCase();
  if (rawGstin) {
    if (GSTIN_RE.test(rawGstin)) gstin = rawGstin;
    else warnings.push({ field: 'gstin', code: 'invalid_gstin', message: `"${rawGstin}" is not a valid GSTIN — imported without GSTIN` });
  }

  if (issues.length) return { ok: false, issues, warnings };

  return {
    ok: true,
    value: {
      name,
      code: clean(row.code) || null,
      phone,
      email,
      city: clean(row.city) || null,
      gstin,
      birthday: optionalIsoDate('birthday', row.birthday, warnings),
      anniversary: optionalIsoDate('anniversary', row.anniversary, warnings),
    },
    issues,
    warnings,
  };
}
