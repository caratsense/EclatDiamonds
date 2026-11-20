"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

const KEY = ["crm", "lead-forms"] as const;

export interface LeadForm {
  id: string;
  publicKey: string;
  name: string;
  storeId: string;
  storeName: string;
  defaultInterest: string | null;
  campaign: string | null;
  allowedOrigins: string[] | null;
  enabled: boolean;
  createdAt: string;
  submitPath: string;
}

export interface CreateLeadFormInput {
  name: string;
  storeId: string;
  defaultInterest?: string;
  campaign?: string;
  allowedOrigins?: string[];
}

/** GET /crm/lead-forms — store manager and above. */
export function useLeadForms() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await api.get<LeadForm[]>("/crm/lead-forms");
      return data;
    },
  });
}

export function useCreateLeadForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLeadFormInput) => {
      const { data } = await api.post<LeadForm>("/crm/lead-forms", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Also the kill switch: pass `{ enabled: false }`. */
export function useUpdateLeadForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<CreateLeadFormInput> & { enabled?: boolean }) => {
      const { data } = await api.patch<LeadForm>(`/crm/lead-forms/${id}`, patch);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/* ------------------------------------------------------------- public side */

export interface PublicLeadFormView {
  name: string;
  defaultInterest: string | null;
  interestOptional: boolean;
}

export interface SubmitLeadFormInput {
  submissionId: string;
  customerName: string;
  phone?: string;
  email?: string;
  interest?: string;
  consent: true;
  /** Honeypot. Real people never see it. */
  website?: string;
}

export interface SubmitLeadFormResult {
  accepted: boolean;
  duplicate: boolean;
  reference: string;
}

/** Thrown by the public calls so the page can tell a dead form from a bad field. */
export class LeadFormError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {
    super(`Lead form request failed with ${status}`);
    this.name = "LeadFormError";
  }
}

const base = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The visitor-facing calls.
 *
 * Plain `fetch`, on purpose. The shared `api` instance attaches the staff JWT
 * and, on any 401, clears it and sends the browser to /login — which is the one
 * screen a stranger on the customer's website can never get past. These routes
 * are `@Public` on the server and need no credentials at all, so the public
 * bundle should not carry the authenticated client or its interceptors either.
 */
export async function fetchPublicLeadForm(publicKey: string): Promise<PublicLeadFormView> {
  const res = await fetch(`${base()}/public/lead-forms/${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new LeadFormError(res.status, await safeJson(res));
  return (await res.json()) as PublicLeadFormView;
}

export async function submitPublicLeadForm(
  publicKey: string,
  input: SubmitLeadFormInput,
): Promise<SubmitLeadFormResult> {
  const res = await fetch(`${base()}/public/lead-forms/${encodeURIComponent(publicKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new LeadFormError(res.status, await safeJson(res));
  return (await res.json()) as SubmitLeadFormResult;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    // A body that is not JSON tells the visitor nothing anyway.
    return null;
  }
}
