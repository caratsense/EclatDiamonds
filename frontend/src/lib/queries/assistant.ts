"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The in-app assistant.
 *
 * Deterministic on the server: each question is matched to an intent and
 * answered with a store-scoped, role-filtered query. No model call, so answers
 * are instant, free and cannot be confidently wrong about money or approvals.
 */

export interface AssistantResultItem {
  id: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  href?: string | null;
  tone?: "neutral" | "warn" | "danger" | "ok";
}

export interface AssistantAnswer {
  intent: string;
  /** One-line answer, already phrased for display. */
  answer: string;
  items: AssistantResultItem[];
  /** Follow-up prompts to render as tappable chips. */
  suggestions: string[];
}

/** GET /assistant/suggestions — the opening chips, filtered by role. */
export function useAssistantSuggestions() {
  return useQuery({
    queryKey: ["assistant", "suggestions"],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await api.get<{ suggestions: string[] }>(
        "/assistant/suggestions",
      );
      return data.suggestions;
    },
  });
}

/** POST /assistant/ask — answer one question. */
export function useAskAssistant() {
  return useMutation({
    mutationFn: async (text: string) => {
      const { data } = await api.post<AssistantAnswer>("/assistant/ask", { text });
      return data;
    },
  });
}
