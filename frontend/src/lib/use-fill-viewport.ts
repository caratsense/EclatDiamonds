"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Make an element reach the bottom of the window, whatever is above it.
 *
 * ## Why this is measured rather than calculated
 *
 * The inbox is three panes that each scroll on their own. When the PAGE also
 * scrolls you get a second scrollbar that moves the whole layout out from under
 * the cursor while you are reading a conversation inside it. So the panes have
 * to be exactly as tall as the space left under the heading and filter row.
 *
 * Two attempts at that failed, each in an instructive way:
 *
 * `h-[calc(100vh-13rem)]` — 13rem was the topbar, the page padding, the heading
 * and the filter row, counted off by hand. It was wrong the moment any of them
 * changed, and it had already drifted.
 *
 * `min-h-full` on the shell, `flex-1 min-h-0` on the page — the idea being that
 * the page could claim the leftover height without anybody naming it. But
 * `min-h-full` is a FLOOR, not a size: the height stays indefinite, so `flex-1`
 * on a child resolves against nothing, the child grows to its content, and the
 * wrapper grows with it. Measured, that left `main` overflowing by 975px.
 *
 * What is left is to ask the browser where the element actually starts and give
 * it the rest. That is self-correcting: change the heading, add a filter row,
 * remove the strip above the panes, and the height follows without anybody
 * remembering this file exists.
 *
 * ## Why a ResizeObserver and not just a resize listener
 *
 * The chrome above this element changes height without the window changing at
 * all — the filter row wraps to two lines on a narrow screen, a banner appears,
 * the customer-thread chip shows up. A window listener misses every one of
 * those and leaves the panes the wrong height until the next resize.
 */
export function useFillViewport<T extends HTMLElement = HTMLDivElement>(options?: {
  /** Space to leave under the element. Matches the shell's bottom padding. */
  gutter?: number;
  /** Never go below this, so a short window keeps the pane usable. */
  min?: number;
}) {
  const gutter = options?.gutter ?? 32;
  const min = options?.min ?? 420;

  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    /*
     * visualViewport is the honest number on a phone: the on-screen keyboard
     * shrinks it, and `innerHeight` does not notice. Typing a reply would
     * otherwise push the composer behind the keyboard.
     */
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    /*
     * FLOOR, not round. `top` is fractional under browser zoom and on a
     * high-DPI display, and rounding up by half a pixel is enough to overflow
     * the container and put the page scrollbar back — which is the entire
     * thing this hook exists to remove. Measured at 1px of overflow before
     * this line said floor.
     */
    setHeight(Math.max(min, Math.floor(viewport - top - gutter)));
  }, [gutter, min]);

  useEffect(() => {
    measure();

    const el = ref.current;
    // The element's own box AND everything above it: a ResizeObserver on the
    // element alone does not fire when the filter row above it wraps.
    const observer = new ResizeObserver(measure);
    if (el) observer.observe(el);
    if (el?.parentElement) observer.observe(el.parentElement);
    if (typeof document !== "undefined") observer.observe(document.body);

    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [measure]);

  /*
   * `null` until the first measurement, and the caller renders no height at
   * all in that frame. Guessing one would show the panes at the wrong size for
   * a tick and then snap, which reads as a flicker on every navigation.
   */
  return { ref, style: height === null ? undefined : { height: `${height}px` } };
}
