"use client";

import * as React from "react";
import Link from "next/link";
import { Coins, ExternalLink } from "lucide-react";

import { useMetalRates } from "@/lib/queries/integrations";
import { useRouteEnabled } from "@/lib/queries/tenant-config";
import { formatINR } from "@/lib/format";
import { ROLE_RANK } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MetalRatesWidget, staleNote } from "@/components/rates/metal-rates-widget";

/**
 * Live gold-rate chip in the top bar.
 * Clicking opens the live Metal Rates card matching official CaratOS specs.
 */
export function GoldRateChip() {
  const [open, setOpen] = React.useState(false);
  const role = useSession((s) => s.role);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const showsRates = useRouteEnabled("settings/rates");
  const { rateFor, isLoading } = useMetalRates();

  const rate = rateFor(22);
  if (!showsRates || isLoading || !rate) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-xs transition-colors hover:bg-muted/60 focus:outline-none focus:ring-1 focus:ring-primary/40",
          )}
          title={
            rate.stale
              ? `22K gold · ${staleNote(rate)} (click for all rates)`
              : `22K gold · ${rate.source === "ibja" ? "IBJA benchmark, excl. GST" : "current rate"} (click for all rates)`
          }
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              rate.stale ? "bg-[var(--warning)]" : "bg-[var(--success)]",
            )}
          />
          <Coins className="h-3.5 w-3.5 text-[var(--gold)]" />
          <span className="num">{formatINR(rate.ratePerGram)}</span>
          <span className="text-muted-foreground">/g 22K</span>
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl border-border/80 bg-[#090e13] p-6 text-foreground sm:rounded-2xl">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
              <Coins className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-white">Today&apos;s Metal Rates</DialogTitle>
              <p className="text-xs text-muted-foreground">The rates every quote is priced from, per gram.</p>
            </div>
          </div>
        </DialogHeader>

        <MetalRatesWidget />

        <div className="flex items-center justify-end pt-2">
          {canEdit && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="gap-1.5 border-slate-700 bg-slate-900/60 text-xs text-slate-200 hover:bg-slate-800"
              onClick={() => setOpen(false)}
            >
              <Link href="/settings/rates">
                <span>Rates page</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
