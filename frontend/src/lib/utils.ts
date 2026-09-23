import { clsx, type ClassValue } from "clsx";
import { AxiosError } from "axios";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Pull a human-readable message out of an API error. NestJS puts the reason in
 * `response.data.message` (string or string[]); fall back to a supplied default
 * so callers can surface a clean inline message instead of crashing.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError) {
    const msg = (err.response?.data as { message?: string | string[] } | undefined)
      ?.message;
    if (Array.isArray(msg) && msg.length > 0) return msg[0];
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return fallback;
}

/**
 * Validate + normalise an Indian mobile number. Mirrors the backend
 * `contact.util.normalizeIndianMobile`: only digits + phone formatting
 * (`+ - ( ) space`) are allowed — letters/symbols are rejected, not stripped —
 * and a `+91`/`91`/leading-`0` prefix is accepted. Returns the canonical
 * 10-digit number, or null if it is not a valid mobile.
 */
export function normalizeIndianMobile(raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^[+\d()\-\s]+$/.test(v)) return null;
  let digits = v.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (!/^[6-9]/.test(digits)) return null;
  return digits;
}

/**
 * What a phone box may hold WHILE IT IS BEING TYPED: digits only, at most ten,
 * with a pasted +91 / 91 / leading 0 dropped as it arrives. An Indian mobile is
 * ten digits, so a box that keeps accepting a twentieth one is only collecting
 * a number nobody can call. Validation still belongs to
 * `normalizeIndianMobile` on submit; this just stops the impossible input.
 */
export function phoneInputValue(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  const local =
    digits.length > 10 && digits.startsWith("91")
      ? digits.slice(2)
      : digits.replace(/^0+/, "");
  return local.slice(0, 10);
}

/**
 * What a quantity box may hold while it is being typed: digits and one decimal
 * point. A weight, a rate, a discount or a carat cannot be negative, so the
 * minus sign never reaches the field.
 */
export function positiveNumberInput(raw: string): string {
  return (raw ?? "").replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

/** Conservative email check (single @, a dot in the domain, no spaces). */
export function isValidEmail(raw: string): boolean {
  const v = (raw ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/**
 * A real, human-meaningful name/title — must contain at least one letter (any
 * script) so a phone number, amount or id can't masquerade as a name. Mirrors
 * the backend `@IsRealName()` validator so the inline check matches the API.
 */
export function isRealName(raw: string): boolean {
  return /\p{L}/u.test((raw ?? "").trim());
}

/**
 * Cap a phone input the way the lead form does: 10 digits for a bare number,
 * 12 when prefixed with "+" (i.e. +91 + 10). Mirrors backend normalization.
 */
export function capIndianPhone(raw: string): string {
  const hasPlus = raw.trimStart().startsWith("+");
  const digits = raw.replace(/\D/g, "").slice(0, hasPlus ? 12 : 10);
  return (hasPlus ? "+" : "") + digits;
}
