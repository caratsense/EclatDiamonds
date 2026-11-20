"use client";

import { useState, useSyncExternalStore } from "react";

/**
 * Re-run `reset` whenever `key` changes, during render rather than in an effect.
 *
 * This is React's documented "adjusting state when a prop changes" pattern, and
 * it replaces the `useEffect(() => { if (open) setX(...) }, [open])` shape that
 * every reset-on-open dialog in this app used to carry.
 *
 * The effect version is not just untidy — it renders the dialog once with the
 * PREVIOUS submission's values still in the fields, then immediately renders
 * again with them cleared. On a slow phone that flash is visible, and on a form
 * a manager reopens quickly it is a real "is this last month's number?" moment.
 * Updating during render means React discards the first pass before the browser
 * ever paints it, so the dialog is only ever seen in its reset state.
 *
 * `reset` may call several setState functions; they are batched into the same
 * render pass. Only state belonging to THIS component may be set from here.
 */
export function useResetOn(key: unknown, reset: () => void): void {
  const [previous, setPrevious] = useState(key);
  if (!Object.is(previous, key)) {
    setPrevious(key);
    reset();
  }
}

/**
 * True once the component has rendered on the client.
 *
 * Reads as `false` during the server render and the hydration pass, then `true`
 * afterwards, without the `useEffect(() => setMounted(true), [])` shape that
 * schedules a second render every time. `subscribe` returns a no-op unsubscribe
 * because the answer never changes after hydration.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}
