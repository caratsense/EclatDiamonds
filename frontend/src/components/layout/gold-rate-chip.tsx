"use client";

import Link from "next/link";
import { Coins } from "lucide-react";

import { useMetalRates } from "@/lib/queries/integrations";
import { useRouteEnabled } from "@/lib/queries/tenant-config";
import { formatINR } from "@/lib/format";
import { ROLE_RANK } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Live gold-rate chip in the top bar — the current 22K rate, on every screen, so
 * whoever is creating a lead or building a quote always sees the latest number
 * without going to look for it. `useMetalRates` polls, so it tracks the auto
 * feed (or a manual override) on its own. Managers tap through to set/override
 * it; everyone else sees it read-only. Renders nothing until a rate exists.
 *
 * ONLY for a tenant whose product actually has a metal rate. The top bar is
 * outside the navigation, so nothing here was ever filtered by industry: a
 * pharmacy got a gold-coin chip reading "₹X /g 22K" on every screen, and for a
 * manager it was a one-click link into /settings/rates — a screen the pack
 * layer means to hide. The rate is real, too: the refresh job runs for every
 * organisation that has a store, so there was always a number to display.
 * Gating on the route keeps the chip and the screen it opens in agreement.
 */
export function GoldRateChip() {
  const role = useSession((s) => s.role);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const showsRates = useRouteEnabled("settings/rates");
  const { rateFor, isLoading } = useMetalRates();

  const rate = rateFor(22);
  if (!showsRates || isLoading || !rate) return null;

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-xs",
        canEdit && "transition-colors hover:bg-muted/60",
      )}
      title={
        rate.stale
          ? `22K gold · updated ${Math.round(rate.ageHours)}h ago`
          : "22K gold · live"
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
    </span>
  );

  return canEdit ? (
    <Link href="/settings/rates" aria-label="Gold rate">
      {content}
    </Link>
  ) : (
    content
  );
}
