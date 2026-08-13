import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Recipient validation for outbound reports (WhatsApp / email).
 *
 * Kept deliberately strict on INPUT — a number is not "valid" just because some
 * digits can be salvaged from it. Letters and stray symbols are rejected rather
 * than silently stripped, because a report is about to be sent to whatever this
 * resolves to. Mirrors the app's phone convention (Indian mobile, last 10
 * digits; see AuthService.normalizePhone) but adds the character + shape checks.
 */

/**
 * Validate + normalise an Indian mobile number. Accepts digits with common
 * formatting only (`+ - ( ) space`); a `+91`/`91`/leading-`0` prefix is allowed.
 * Returns the canonical 10-digit number, or null if it is not a valid mobile.
 */
export function normalizeIndianMobile(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  // Only digits + phone formatting are allowed — letters/symbols → reject.
  if (!/^[+\d()\-\s]+$/.test(v)) return null;

  let digits = v.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== 10) return null;
  // Indian mobile numbers start 6–9.
  if (!/^[6-9]/.test(digits)) return null;
  return digits;
}

/** Basic, conservative email check (single @, a dot in the domain, no spaces). */
export function isValidEmail(raw: string): boolean {
  const v = (raw ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/**
 * class-validator decorator: the value must be a valid Indian mobile number
 * (same rule as {@link normalizeIndianMobile} — rejects letters/symbols, needs
 * 10 digits starting 6–9). Pair with `@IsOptional()` for optional fields.
 */
export function IsIndianMobile(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIndianMobile',
      target: object.constructor,
      propertyName,
      options: { message: 'must be a valid 10-digit Indian mobile number', ...options },
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && normalizeIndianMobile(value) != null;
        },
      },
    });
  };
}
