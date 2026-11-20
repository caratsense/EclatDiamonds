"use client";

import { Info } from "lucide-react";

import { imageSourceLabel } from "@/lib/mock/catalogue";
import { cn } from "@/lib/utils";

const ORIGIN: Record<string, string> = {
  gati_cad: "CAD drawing from Gati, synced automatically.",
  website: "Photo from the website, synced automatically.",
  manual: "Added by hand in CaratSpace.",
  inventory: "Photo of a piece in stock.",
  other: "The design's older cover picture, from before CaratSpace recorded where photos come from.",
};

/**
 * Where a catalogue picture came from, line by line: what kind of picture it
 * is, the file or website it was taken from when the source recorded one,
 * and when it reached CaratSpace.
 */
export function imageOrigin(source?: string | null, sourceUrl?: string | null, addedAt?: string | null): string[] {
  const lines = [ORIGIN[source ?? ""] ?? "Where this photo came from was not recorded."];
  try {
    const u = new URL(sourceUrl ?? "");
    const file = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    // A CAD sheet's link is our own storage; only its file name says which Gati picture it is.
    if (source === "website") lines.push(`From ${u.host}${file ? `: ${file}` : ""}`);
    else if (file) lines.push(`File: ${file}`);
  } catch {
    // No link, or a relative one: nothing more to say.
  }
  const at = addedAt ? new Date(addedAt) : null;
  if (at && !Number.isNaN(at.getTime())) {
    const day = at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    lines.push(source === "manual" ? `Added on ${day}` : `In CaratSpace since ${day}`);
  }
  return lines;
}

/**
 * The source of a catalogue picture as a small "ⓘ CAD" tag; hovering it (or
 * tapping/focusing it where `focusable`) shows where the picture actually came from.
 *
 * Renders the tag and its tip as SIBLINGS, both positioned by the caller's
 * `relative` container: the tip then spans the picture instead of being cut
 * off by a narrow card's `overflow-hidden`. Inside a card that is itself a
 * button, leave `focusable` off: a focusable element inside a button is a
 * control inside a control.
 */
export function ImageSourceTag({
  source,
  sourceUrl,
  addedAt,
  focusable = false,
  className,
  tipClassName = "inset-x-1.5 top-8",
}: {
  source?: string | null;
  sourceUrl?: string | null;
  addedAt?: string | null;
  focusable?: boolean;
  /** Where the tag sits, e.g. "absolute left-1.5 top-1.5". */
  className?: string;
  /** Where the tip opens, inside the same container. */
  tipClassName?: string;
}) {
  const lines = imageOrigin(source, sourceUrl, addedAt);
  return (
    <>
      <span
        role="img"
        tabIndex={focusable ? 0 : undefined}
        aria-label={`Photo source: ${lines.join(" ")}`}
        data-testid="image-source-tag"
        className={cn(
          "peer/src z-10 inline-flex cursor-help items-center gap-1 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Info className="h-3 w-3" aria-hidden />
        {imageSourceLabel(source) ?? "Unknown"}
      </span>
      <span
        role="tooltip"
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-20 hidden rounded-md bg-popover px-2 py-1.5 text-left text-[11px] font-normal leading-snug text-popover-foreground shadow-md ring-1 ring-border peer-hover/src:block peer-focus/src:block",
          tipClassName,
        )}
      >
        {lines.map((line) => (
          <span key={line} className="block break-words">
            {line}
          </span>
        ))}
      </span>
    </>
  );
}
