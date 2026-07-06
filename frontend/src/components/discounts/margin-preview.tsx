"use client";

import * as React from "react";
import { ArrowRight, TrendingDown } from "lucide-react";

import { formatINR, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MarginPreviewProps {
  listPrice: number;
  cost: number;
  discountPct: number;
}

/**
 * Margin-impact preview (Module 15): real-time before/after profit analysis
 * so an approver sees what the discount does to margin before signing off.
 */
export function MarginPreview({
  listPrice,
  cost,
  discountPct,
}: MarginPreviewProps) {
  const discountAmt = (listPrice * discountPct) / 100;
  const netPrice = listPrice - discountAmt;

  const marginBefore = listPrice - cost;
  const marginAfter = netPrice - cost;
  const marginPctBefore = listPrice > 0 ? (marginBefore / listPrice) * 100 : 0;
  const marginPctAfter = netPrice > 0 ? (marginAfter / netPrice) * 100 : 0;
  const erosion = marginPctBefore - marginPctAfter;

  const lossMaking = marginAfter < 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="List price" value={formatINR(listPrice)} />
        <Stat label="Landed cost" value={formatINR(cost)} muted />
        <Stat
          label={`Discount (${formatPercent(discountPct)})`}
          value={`− ${formatINR(discountAmt)}`}
          tone="destructive"
        />
        <Stat label="Net price" value={formatINR(netPrice)} emphasize />
      </div>

      <div className="rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Margin before</p>
            <p className="num text-base font-semibold">
              {formatPercent(marginPctBefore)}
            </p>
            <p className="num text-xs text-muted-foreground">
              {formatINR(marginBefore)}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Margin after</p>
            <p
              className={cn(
                "num text-base font-semibold",
                lossMaking ? "text-destructive" : "text-emerald-600",
              )}
            >
              {formatPercent(marginPctAfter)}
            </p>
            <p className="num text-xs text-muted-foreground">
              {formatINR(marginAfter)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Erosion</p>
            <p className="num flex items-center gap-1 text-base font-semibold text-amber-600">
              <TrendingDown className="h-4 w-4" />
              {formatPercent(erosion)}
            </p>
          </div>
        </div>
        {lossMaking ? (
          <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
            This discount pushes the sale below cost — loss-making.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  muted,
  emphasize,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  emphasize?: boolean;
  tone?: "destructive";
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "num",
          emphasize ? "text-lg font-semibold" : "text-sm font-medium",
          muted && "text-muted-foreground",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}
