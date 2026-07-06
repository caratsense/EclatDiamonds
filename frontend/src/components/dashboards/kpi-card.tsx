"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Coins,
  IndianRupee,
  Package,
  Percent,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatINRCompact, formatNumber, formatPercent } from "@/lib/format";

interface KpiCardProps {
  label: string;
  value: number;
  format: "inr" | "number";
  delta: number;
  /** When true, a negative delta is "good" (e.g. pending orders, costs). */
  invertDelta?: boolean;
  /** Position in a row — cycles the accent palette for visual rhythm. */
  index?: number;
}

/** Map a KPI label to a fitting glyph. */
function pickIcon(label: string): LucideIcon {
  const l = label.toLowerCase();
  if (l.includes("sale") || l.includes("revenue")) return IndianRupee;
  if (l.includes("footfall") || l.includes("walk") || l.includes("check"))
    return Users;
  if (l.includes("order")) return Package;
  if (l.includes("collection") || l.includes("payment") || l.includes("due"))
    return Wallet;
  if (l.includes("margin") || l.includes("ebitda") || l.includes("ticket value"))
    return TrendingUp;
  if (l.includes("expense") || l.includes("opex") || l.includes("cost"))
    return Banknote;
  if (l.includes("conversion") || l.includes("rate")) return Percent;
  if (l.includes("bill")) return Activity;
  return Coins;
}

/**
 * KPI tile. The first tile in a row is the hero — it carries the gold
 * light-catch (the signature) and a gold icon chip so the single most
 * important number is unmistakable. The rest stay quiet stone. The hero
 * figure is set in the display face; deltas are jewel-tone pills.
 */
export function KpiCard({
  label,
  value,
  format,
  delta,
  invertDelta,
  index,
}: KpiCardProps) {
  const positive = invertDelta ? delta < 0 : delta > 0;
  const Arrow = delta >= 0 ? ArrowUpRight : ArrowDownRight;
  const Icon = pickIcon(label);
  const isHero = (index ?? 0) === 0;

  return (
    <Card
      data-active={isHero ? "true" : undefined}
      className="facet-top group relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      {/* corner sheen — gold on the hero tile, a faint warm wash elsewhere */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br to-transparent blur-2xl transition-opacity",
          isHero
            ? "from-[color-mix(in_srgb,var(--gold)_22%,transparent)] opacity-90"
            : "from-[color-mix(in_srgb,var(--foreground)_8%,transparent)] opacity-50 group-hover:opacity-80",
        )}
      />
      <CardContent className="relative p-5">
        <div className="flex items-start justify-between">
          <span
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl",
              isHero
                ? "bg-[color-mix(in_srgb,var(--gold)_14%,transparent)] text-gold-strong"
                : "bg-secondary text-muted-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
              positive
                ? "bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-success"
                : "bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] text-destructive",
            )}
          >
            <Arrow className="h-3 w-3" />
            {formatPercent(Math.abs(delta))}
          </span>
        </div>

        <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-1.5 font-display text-[32px] font-medium leading-none tracking-tight tabular-nums text-foreground">
          {format === "inr" ? formatINRCompact(value) : formatNumber(value)}
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground">vs prior period</p>
      </CardContent>
    </Card>
  );
}
