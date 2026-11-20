/**
 * Feature switches for parts of the UI that are built but not yet wanted on
 * screen.
 *
 * These are deliberately *hidden, not deleted*. Both features below work well
 * enough to keep, but showing a search box that returns nothing — or an
 * assistant nobody asked for — costs more trust than the feature earns back.
 * Hiding keeps the code exercised by the build and one edit away from returning.
 *
 * To turn one back on, either flip the default here, or set the matching env var
 * and REDEPLOY:
 *
 *   NEXT_PUBLIC_ENABLE_SEARCH=true
 *   NEXT_PUBLIC_ENABLE_ASSISTANT=true
 *
 * Redeploy is not optional. `NEXT_PUBLIC_*` values are inlined into the client
 * bundle at `next build` and frozen there, so changing one in the Vercel
 * dashboard does nothing until the project is rebuilt.
 *
 * Each flag is read as a direct `process.env.NEXT_PUBLIC_…` reference on purpose:
 * Next only inlines that literal form, and a destructured or computed lookup
 * silently evaluates to undefined in the browser. Compared with `=== "true"`
 * rather than for truthiness, since these arrive as strings and "false" is truthy.
 */

/**
 * Global search (Ctrl/Cmd+K). Off: the backend has no search index yet, so the
 * field matches nothing and reads as a broken feature.
 */
export const SEARCH_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SEARCH === "true";

/**
 * Floating assistant. Off by request — not needed at this stage. The panel and
 * its deterministic query layer are untouched, so re-enabling is just the flag.
 */
export const ASSISTANT_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_ASSISTANT === "true";
