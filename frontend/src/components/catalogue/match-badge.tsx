import { Badge } from "@/components/ui/badge";
import type { MatchLevel } from "@/lib/queries/jewelry-similarity";

/** Match-level → label + colour-coded Badge variant. Shared by Find-Similar and the catalogue AI search. */
export const MATCH_LEVEL: Record<
  MatchLevel,
  { label: string; variant: "success" | "gold" | "default" | "outline" }
> = {
  VERY_CLOSE: { label: "Very Close", variant: "success" },
  CLOSE: { label: "Close", variant: "gold" },
  SIMILAR: { label: "Similar", variant: "default" },
  WEAK: { label: "Weak", variant: "outline" },
  NO_CLOSE_MATCH: { label: "No Close Match", variant: "outline" },
};

/** Closeness shown as a colour-coded level badge — never a raw cosine. */
export function MatchBadge({ level }: { level: MatchLevel }) {
  const m = MATCH_LEVEL[level];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
