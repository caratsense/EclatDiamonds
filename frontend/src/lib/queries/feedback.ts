import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Feedback.
 *
 * The public half deliberately uses plain `fetch`, not the shared axios
 * instance — that instance has a 401 interceptor which would bounce a customer
 * answering a survey to /login. Same reasoning as the public enquiry form.
 */

/**
 * One of the two requests that go out after a walk-in.
 *
 * `delayHours` chooses the local DAY and `sendTimeLocal` the hour: whole days
 * are counted from the visit's own local day, so 24 and 30 hours both land on
 * the day after. Anything shown on screen about when a request goes out has to
 * be worked out the same way, or the screen and the sweep disagree.
 */
export interface AfterVisitStep {
  /** 1 = the request itself, 2 = the later one. The order is the meaning. */
  step: 1 | 2;
  enabled: boolean;
  delayHours: number;
  /** "HH:MM" at the branch. */
  sendTimeLocal: string;
  templateName: string | null;
  templateLanguage: string | null;
}

/** The automatic ask after a walk-in with no follow-up booked. */
export interface AfterVisitPolicy {
  enabled: boolean;
  /*
   * Step one, flattened, under the keys this policy has always been read
   * under — the same four facts as `steps[0]`.
   */
  delayDays: number;
  /** "HH:MM" at the branch. */
  sendTimeLocal: string;
  templateName: string | null;
  templateLanguage: string | null;
  /**
   * The request, then the later one — always two, each with its own switch,
   * from an API that has the second step.
   *
   * Optional because the browser bundle and the API deploy separately: a
   * browser on this bundle can be talking to an API that has not rolled out
   * yet, and the settings screen must still draw the request a branch actually
   * has configured rather than an empty form. `afterVisitSteps` in
   * components/feedback is the one place that resolves it.
   */
  steps?: [AfterVisitStep, AfterVisitStep];
}

/**
 * What a settings PATCH may carry.
 *
 * Only the fields actually sent are applied, so a partial step is a partial
 * edit rather than a reset. `steps` is sparse on purpose: `[undefined, {...}]`
 * changes the second request and leaves the first alone.
 */
export type AfterVisitPolicyInput = Partial<Omit<AfterVisitPolicy, "steps">> & {
  steps?: Array<Partial<AfterVisitStep> | undefined>;
};

export interface FeedbackSettings {
  enabled: boolean;
  positiveThreshold: number;
  escalateAtOrBelow: number;
  reviewLinks: Record<string, string>;
  afterVisit: AfterVisitPolicy;
}

export type FeedbackSettingsInput = Partial<Omit<FeedbackSettings, "afterVisit">> & {
  afterVisit?: AfterVisitPolicyInput;
};

export interface FeedbackSummary {
  responses: number;
  asked: number;
  /** null when nothing was answered — an average of nothing is not zero. */
  averageRating: number | null;
  responseRate: number | null;
  distribution: Record<string, number>;
  escalated: number;
  windowDays: number;
}

export interface FeedbackResponse {
  id: string;
  rating: number | null;
  comment: string | null;
  respondedAt: string | null;
  storeId: string | null;
  escalated: boolean;
  escalatedTaskId: string | null;
  reviewLinkOffered: boolean;
  customer: { id: string; name: string } | null;
}

export function useFeedbackSettings() {
  return useQuery({
    queryKey: ["feedback", "settings"],
    queryFn: async () => {
      const { data } = await api.get<FeedbackSettings>("/feedback/settings");
      return data;
    },
  });
}

export function useUpdateFeedbackSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: FeedbackSettingsInput) => {
      const { data } = await api.patch<FeedbackSettings>("/feedback/settings", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

export function useFeedbackSummary(params: { storeId?: string; days?: number } = {}) {
  return useQuery({
    queryKey: ["feedback", "summary", params],
    queryFn: async () => {
      const { data } = await api.get<FeedbackSummary>("/feedback/summary", { params });
      return data;
    },
  });
}

export function useFeedbackResponses(params: { storeId?: string; escalatedOnly?: boolean } = {}) {
  return useQuery({
    queryKey: ["feedback", "responses", params],
    queryFn: async () => {
      const { data } = await api.get<{
        items: FeedbackResponse[];
        nextCursor: string | null;
      }>("/feedback/responses", { params: { ...params, limit: 50 } });
      return data;
    },
  });
}

export function useRequestFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { partyId: string; storeId?: string; checkInId?: string }) => {
      const { data } = await api.post<{
        id: string;
        publicKey: string;
        responsePath: string;
        expiresAt: string | null;
      }>("/feedback/requests", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

/* ------------------------------------------------------------------ public */

export class FeedbackError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {
    super(`Feedback request failed with ${status}`);
    this.name = "FeedbackError";
  }
}

/* Same fallback the public enquiry form uses, so the two agree. */
function publicBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
}

export async function fetchPublicFeedback(publicKey: string) {
  const res = await fetch(`${publicBase()}/public/feedback/${encodeURIComponent(publicKey)}`, {
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new FeedbackError(res.status, data);
  return data as { businessName: string; alreadyAnswered: boolean };
}

export async function submitPublicFeedback(
  publicKey: string,
  body: { rating: number; comment?: string },
) {
  const res = await fetch(`${publicBase()}/public/feedback/${encodeURIComponent(publicKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new FeedbackError(res.status, data);
  return data as { accepted: boolean; reviewLink: string | null; escalated: boolean };
}
