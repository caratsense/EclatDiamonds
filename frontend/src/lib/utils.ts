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

/** Conservative email check (single @, a dot in the domain, no spaces). */
export function isValidEmail(raw: string): boolean {
  const v = (raw ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}
