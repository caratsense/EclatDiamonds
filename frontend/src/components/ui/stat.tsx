/**
 * The headline-figure treatment, in one place.
 *
 * Three screens carry the numbers a manager looks at first — the CRM
 * omnichannel bar, the floor app's Today panel and the calling queue's four
 * buckets — and all three had drifted into their own size, weight and face. A
 * figure that changes shape between screens reads as a different KIND of
 * figure, so somebody has to stop and work out whether it is.
 *
 * `.num` (globals.css) is the existing house rule for a numeral: the mono face,
 * lining and tabular figures, so a column of them lines up and a changing count
 * does not shuffle the digits beside it.
 *
 * Classes rather than a component, deliberately: one of these tiles is a
 * button, one is a plain div and one wraps a link, and forcing a single wrapper
 * on all three would cost more than it saves.
 */

/** Above the number. Small, spaced, quiet — the number is the loud part. */
export const STAT_LABEL =
  "flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";

/**
 * The number itself. Colour is left to the caller so a tile that needs to shout
 * (an overdue count above zero) can set its own without fighting a token already
 * baked in here — two text-colour utilities on one element are decided by
 * stylesheet order, not by the order they were written.
 *
 * On the size: 15px, written in pixels rather than picked off the type scale,
 * because the mono face sets about a third wider than the body sans and no step
 * on that scale lands where this needs to. It reads like a 20px sans figure.
 *
 * This number was decorative until recently: `.num` sat outside the cascade
 * layers and its `font-size` beat whatever was written here, so the tile value
 * rendered at 0.92 x its container no matter what this said. The rule is in
 * `@layer base` now (globals.css), which is what makes this declaration real —
 * and 15px is deliberately near the 14.72px it used to resolve to, so repairing
 * the cascade did not quietly enlarge every figure in the product.
 */
export const STAT_VALUE = "num text-[15px] font-bold tracking-tight";

/** Same figure, half a step down, for a tile in a row of six or more. */
export const STAT_VALUE_SM = "num text-[13px] font-bold tracking-tight";
