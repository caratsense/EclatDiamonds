"use client";

import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface IssueLeadQrInput {
  storeId: string;
  /** Where the poster will live, e.g. "Front counter". Shown only to staff. */
  label?: string;
  /** Pre-fills the visitor's enquiry when they leave the field blank. */
  defaultInterest?: string;
  /** 1 to 2160 (90 days). The API defaults to 30 days. */
  expiresInHours?: number;
}

export interface IssuedLeadQr {
  /** The sealed token. It IS the poster's identity — treat it as a secret. */
  token: string;
  capturePath: string;
  expiresAt: string;
  storeName: string;
  label: string | null;
}

/** POST /crm/lead-qr — store manager and above. */
export function useIssueLeadQr() {
  return useMutation({
    mutationFn: async (input: IssueLeadQrInput) => {
      const { data } = await api.post<IssuedLeadQr>("/crm/lead-qr", input);
      return data;
    },
  });
}

export interface CaptureLeadInput {
  /** Stable per form load, so a double-tap returns the first lead, not a second. */
  submissionId: string;
  customerName: string;
  phone: string;
  interest?: string;
  consent: true;
  /** Honeypot. Real people never see it; bots fill it and are refused. */
  website?: string;
}

export interface CaptureLeadResult {
  accepted: boolean;
  duplicate: boolean;
  leadId: string;
  reference: string;
}

/** Thrown by `captureLead` so the page can tell an expired code from a bad field. */
export class CaptureError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {
    super(`Lead capture failed with ${status}`);
    this.name = "CaptureError";
  }
}

/**
 * POST /crm/qr/capture/:token — the visitor-facing submit.
 *
 * Plain `fetch`, deliberately, on both counts:
 *
 * Not the shared `api` instance, because that one attaches the staff JWT and,
 * on any 401, clears it and sends the browser to /login. The person standing
 * at the counter has no session and must never be bounced to a sign-in screen
 * they cannot use. This route is `@Public` on the server and needs no
 * credentials at all — so the public bundle should not carry the authenticated
 * client, its interceptors or its localStorage reads either.
 *
 * And not axios, because a relative URL with no configured baseURL threw
 * before reaching the network, which surfaced to the visitor as "we could not
 * reach the shop" for what was really a validation error. fetch resolves the
 * path against the page's own origin, which is exactly what the `/_api`
 * rewrite expects.
 */
export async function captureLead(
  token: string,
  input: CaptureLeadInput,
): Promise<CaptureLeadResult> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const res = await fetch(
    `${base}/crm/qr/capture/${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // A body that is not JSON tells the visitor nothing anyway.
    }
    throw new CaptureError(res.status, data);
  }
  return (await res.json()) as CaptureLeadResult;
}
