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
