"use client";

import * as React from "react";
import { AlertTriangle, Calendar } from "lucide-react";

import { formatINR } from "@/lib/format";
import { useMetalRates, type MetalKind, type MetalRate } from "@/lib/queries/integrations";
import { cn } from "@/lib/utils";

type Tab = "Gold" | "Silver";

const GOLD_CARDS: Array<[MetalKind, string]> = [
  ["gold_24k", "24K Gold (999) /g"],
  ["gold_22k", "22K Gold (916) /g"],
  ["gold_18k", "18K Gold (750) /g"],
  ["gold_14k", "14K Gold (585) /g"],
];
const DERIVED_ROW: Array<[MetalKind, string]> = [
  ["gold_10k", "10K"],
  ["gold_9k", "9K"],
];

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** Where the rates came from, in words, for the footer of every rates view. */
export function rateSourceLabel(r: MetalRate | null | undefined): string {
  if (!r) return "No rate on record yet";
  if (r.source === "ibja") return `IBJA benchmark (ibjarates.com) · excl. GST${r.publishedOn ? ` · published ${day(r.publishedOn)}` : ""}`;
  if (r.source === "manual") return `Entered by hand · ${day(r.effectiveFrom)}`;
  return `Market feed · ${day(r.effectiveFrom)}`;
}

/**
 * Today's metal rates, as stored — the same numbers the top-bar chip and every
 * quote use. Nothing here is invented: a rate that is not on record is not shown.
 */
export function MetalRatesWidget({ className }: { className?: string; compact?: boolean }) {
  const { data, rateFor, isLoading } = useMetalRates();
  const [tab, setTab] = React.useState<Tab>("Gold");
  const byMetal = (m: MetalKind) => data?.find((r) => r.metal === m) ?? null;
  const fine = rateFor(24);
  const silver = byMetal("silver");
  const shownOn = fine?.publishedOn ?? fine?.effectiveFrom ?? null;
  const cards = tab === "Gold" ? GOLD_CARDS.map(([m, t]) => [byMetal(m), t] as const).filter(([r]) => r) : silver ? ([[silver, "Silver (999) /g"]] as const) : [];

  return (
    <div className={cn("rounded-2xl border border-border/80 bg-[#0d151c] p-4 text-slate-100 shadow-xl backdrop-blur-md", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-1.5 text-xs font-medium text-slate-300 shadow-xs">
            <Calendar className="h-3.5 w-3.5 text-emerald-400" />
            <span>{shownOn ? day(shownOn) : "—"}</span>
          </div>
          {silver ? (
            <div className="flex items-center rounded-lg border border-slate-800 bg-slate-950/80 p-0.5 text-xs">
              {(["Gold", "Silver"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded-md px-3.5 py-1 text-xs font-semibold transition-all",
                    tab === t ? "bg-[#059669] text-white shadow-xs" : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {fine?.stale ? (
          <span className="flex items-center gap-1 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" /> Last updated {Math.round(fine.ageHours)}h ago
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="mt-3.5 text-sm text-slate-400">Loading rates…</p>
      ) : cards.length === 0 ? (
        <p className="mt-3.5 text-sm text-slate-400">No rate on record yet.</p>
      ) : (
        <div className="mt-3.5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map(([r, title]) => (
            <div key={title} className="flex flex-col justify-between rounded-xl border border-slate-800/80 bg-[#131f28]/80 p-3.5">
              <span className="text-xs font-medium text-slate-400">{title}</span>
              <span className="mt-2.5 font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
                {r!.ratePerGram < 1000 ? `₹${r!.ratePerGram.toFixed(2)}` : formatINR(Math.round(r!.ratePerGram))}
              </span>
              {tab === "Silver" ? <span className="mt-1 text-[11px] text-slate-400">{formatINR(Math.round(r!.ratePerGram * 1000))} /kg</span> : null}
            </div>
          ))}
        </div>
      )}

      {tab === "Gold" && DERIVED_ROW.some(([m]) => byMetal(m)) ? (
        <p className="mt-3 text-[11px] text-slate-400">
          {DERIVED_ROW.filter(([m]) => byMetal(m))
            .map(([m, label]) => `${label} ${formatINR(Math.round(byMetal(m)!.ratePerGram))}/g`)
            .join(" · ")}{" "}
          — derived from 999 by purity (not published by IBJA)
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-slate-400">Source: {rateSourceLabel(fine)}</p>
    </div>
  );
}
