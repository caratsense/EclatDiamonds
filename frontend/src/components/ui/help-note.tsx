import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One short line of helper text, with the rule behind a disclosure.
 *
 * The paragraphs under our controls were each written for a good reason — they
 * carry policy a user genuinely cannot infer, and cutting them would lose it.
 * What they cannot be is permanently on screen: set in muted grey under every
 * field, they are at once unmissable and unread, and six of them on a settings
 * page is the wall the CTO was looking at.
 *
 * So the lede says what this control does, and `more` holds the rule for
 * whoever is meeting it for the first time. Nothing is deleted; it stops being
 * shouted.
 *
 * Native `<details>` rather than a popover: no tooltip or popover primitive
 * exists in this codebase, and `<details>` is keyboard-operable and announced
 * by screen readers with no wiring at all. It also prints open-or-shut as the
 * reader left it, which a popover cannot.
 */
export function HelpNote({
  children,
  more,
  label = "Why",
  className,
}: {
  /** The one short line that stays on screen. */
  children: ReactNode;
  /** The rule, shown only when asked for. */
  more: ReactNode;
  /** Wording of the toggle, when "Why" does not fit the thing being explained. */
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1 text-xs text-muted-foreground", className)}>
      <p>{children}</p>
      <details className="group">
        <summary
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 font-medium underline-offset-2 hover:underline",
            // Safari draws its own triangle from a pseudo-element that
            // `list-style: none` does not reach.
            "list-none [&::-webkit-details-marker]:hidden",
          )}
        >
          {label}
          <ChevronDown
            aria-hidden
            className="size-3 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-1.5 max-w-prose border-l-2 pl-3 leading-relaxed">{more}</div>
      </details>
    </div>
  );
}
