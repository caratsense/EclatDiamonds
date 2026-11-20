import { cn } from "@/lib/utils";

/**
 * One pill, one meaning, everywhere.
 *
 * Converted on the visits tab, hot on the lead table and completed in the
 * calling queue are the SAME state to a person walking past the screen, and
 * before this they were three different greens. Colour is the fastest thing the
 * eye reads on a dense table, so it has to mean the same thing on every one of
 * them.
 *
 * Tone is the meaning, not the wording: `good` is the outcome you wanted,
 * `bad` needs somebody, `wait` is in progress, `mute` is simply recorded.
 * Each carries a border as well as a tint, because a tint alone disappears
 * against a tinted row, and each states its dark-mode text colour so it never
 * inherits an unreadable one.
 */
export type PillTone = "good" | "bad" | "wait" | "mute";

const TONE: Record<PillTone, string> = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  bad: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30",
  wait: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  mute: "bg-muted text-muted-foreground border-border",
};

export function StatusPill({
  tone = "mute",
  className,
  children,
  title,
}: {
  tone?: PillTone;
  className?: string;
  children: React.ReactNode;
  /** Say what the pill means when the word alone is not enough. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The lead priority temperature, which is a recency signal — see below. */
export const TEMPERATURE_TONE: Record<string, PillTone> = {
  hot: "good",
  warm: "wait",
  cold: "mute",
};
