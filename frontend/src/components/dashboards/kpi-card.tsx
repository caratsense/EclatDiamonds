"use client";

import { createElement } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Boxes,
  ChevronRight,
  Coins,
  Footprints,
  Gem,
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
  /** Percentage change vs prior period; `null` = no comparison, hide the pill. */
  delta: number | null;
  /** When true, a negative delta is "good" (e.g. pending orders, costs). */
  invertDelta?: boolean;
  /** Position in a row — cycles the accent palette for visual rhythm. */
  index?: number;
  /** When set, the whole tile is a link to the matching detail page. */
  href?: string;
}

/** Map a KPI label to a fitting glyph. */
function pickIcon(label: string): LucideIcon {
  const l = label.toLowerCase();
  if (l.includes("sale") || l.includes("revenue")) return IndianRupee;
  // Footfall is people arriving, Customers is the people themselves; both
  // read as Users, so walk-ins take the footprint to keep the two apart.
  if (l.includes("footfall") || l.includes("walk") || l.includes("check"))
    return Footprints;
  if (l.includes("order")) return Package;
  if (l.includes("collection") || l.includes("payment") || l.includes("due"))
    return Wallet;
  if (l.includes("margin") || l.includes("ebitda") || l.includes("ticket value"))
    return TrendingUp;
  if (l.includes("expense") || l.includes("opex") || l.includes("cost"))
    return Banknote;
  if (l.includes("conversion") || l.includes("rate")) return Percent;
  if (l.includes("bill")) return Activity;
  // Customers / designs / stock all used to fall through to Coins, which put
  // three identical glyphs side by side on the second row of the dashboard.
  if (l.includes("customer") || l.includes("lead")) return Users;
  if (l.includes("design") || l.includes("style") || l.includes("catalogue"))
    return Gem;
  if (l.includes("stock") || l.includes("piece") || l.includes("inventory"))
    return Boxes;
  return Coins;
}

/**
 * KPI tile. The first tile in a row is the hero: it carries a red accent rule
 * down its leading edge, so the single most important number is marked by one
 * signal rather than the three decorations it used to carry (a gradient
 * hairline, a blurred corner sheen and a lift on hover). The hero figure is
 * set in the display face; deltas are jewel-tone pills.
 */
export function KpiCard({
  label,
  value,
  format,
  delta,
  invertDelta,
  index,
  href,
}: KpiCardProps) {
  const hasDelta = delta != null;
  const positive = invertDelta ? delta! < 0 : delta! > 0;
  const Arrow = delta! >= 0 ? ArrowUpRight : ArrowDownRight;
  // createElement, not `const Icon = …`: a capitalised local holding a
  // per-render lookup reads as a component defined during render, and React
  // remounts a component whose type identity changes.
  const icon = createElement(pickIcon(label), { className: "h-5 w-5" });
  const isHero = (index ?? 0) === 0;

  const card = (
    <Card
      data-active={isHero ? "true" : undefined}
      className={cn(
        // Flat surface, hairline edge. The tile used to carry a gradient
        // hairline, a blurred corner sheen and a lift-on-hover; three
        // decorations competing with the one number the tile exists to show.
        // The hero tile is now marked by a left accent rule instead — one
        // signal, and one that still reads at a glance on a greyscale print.
        "group relative overflow-hidden transition-colors duration-150",
        href && "cursor-pointer hover:border-primary/40",
      )}
    >
      {/* The hero tile's accent rule, as an element rather than `border-l-2
          border-l-primary`: Card sets the shorthand `border-color`, which is
          emitted after the longhand `border-left-color` and silently wins, so
          the border approach takes the width and keeps the grey. */}
      {isHero ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      ) : null}
      <CardContent className="relative p-3.5">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {label}
          </p>
          {href ? (
            <ChevronRight
              className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden
            />
          ) : null}
        </div>
        <div className="mt-2 flex items-baseline gap-1.5">
          {/* Numeric hero wears the mono "assay readout": the display serif's
              oldstyle figures bounce off the baseline (never set digits in it). */}
          <p className="num min-w-0 truncate text-[17px] font-semibold leading-none tracking-tight text-foreground">
            {format === "inr" ? formatINRCompact(value) : formatNumber(value)}
          </p>
          {/* The delta rides the figure's own line rather than taking a third
              row, and drops its filled pill: at seven tiles across, seven
              coloured chips were more colour than the figures they annotate. */}
          {hasDelta ? (
            <span
              className={cn(
                "ml-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold tabular-nums",
                positive ? "text-success" : "text-destructive",
              )}
              title={`${formatPercent(Math.abs(delta!))} vs yesterday`}
            >
              <Arrow className="h-3 w-3" />
              {formatPercent(Math.abs(delta!))}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <Link href={href} aria-label={`${label} — view details`} className="block">
        {card}
      </Link>
    );
  }
  return card;
}
