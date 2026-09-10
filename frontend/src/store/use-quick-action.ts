"use client";

import { create } from "zustand";

/**
 * One pending "start this now" request, handed from the sidebar to the screen
 * that owns the dialog.
 *
 * Deliberately NOT a query parameter. `?new=1` would need `useSearchParams` in
 * every target page, which in this App Router build means a Suspense boundary
 * per page or a prerender failure — a lot of scaffolding for a flag that is
 * read once, milliseconds after it is written, and is meaningless in a
 * bookmark.
 *
 * Screens read it as DERIVED STATE (`open = local || pending === "lead"`) and
 * clear it on close. Nothing here is written from inside an effect, so there is
 * no render-then-correct flash and nothing to synchronise.
 */
export type QuickActionKind = "lead" | "checkin";

interface QuickActionState {
  /** What the user asked to start, until the owning screen picks it up. */
  pending: QuickActionKind | null;
  request: (kind: QuickActionKind) => void;
  clear: () => void;
}

export const useQuickAction = create<QuickActionState>((set) => ({
  pending: null,
  request: (kind) => set({ pending: kind }),
  clear: () => set({ pending: null }),
}));
