"use client";

import { useState } from "react";
import { Coins, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getNavItem } from "@/lib/navigation";
import { formatINR } from "@/lib/format";
import {
  useGoldRateHealth,
  useIntegrationStatus,
  useMetalRates,
  useRefreshGoldRate,
  useSetGoldRate,
  type MetalKind,
} from "@/lib/queries/integrations";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage, cn, positiveNumberInput } from "@/lib/utils";
import { useSession } from "@/store/use-session";

import { MetalRatesWidget, staleNote } from "@/components/rates/metal-rates-widget";

const nav = getNavItem("settings/rates")!;

const METAL_LABEL: Partial<Record<MetalKind, string>> = {
  gold_24k: "Gold 24K (fine)",
  gold_22k: "Gold 22K",
  gold_18k: "Gold 18K",
};

/** Purities the shop actually quotes off, in display order. */
const SHOWN: MetalKind[] = ["gold_24k", "gold_22k", "gold_18k"];

function ageLabel(ageHours: number): string {
  if (ageHours < 1) return "just now";
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  return `${Math.round(ageHours / 24)}d ago`;
}

/** How long ago the scheduled refresh ran, in a sentence. */
function refreshAge(ageHours: number | null): string {
  if (ageHours === null) return "at an unknown time";
  if (ageHours < 1) return "less than an hour ago";
  if (ageHours < 24) return `${Math.round(ageHours)} hours ago`;
  const days = Math.round(ageHours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export default function RatesPage() {
  const role = useSession((s) => s.role);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const { data: rates, isLoading } = useMetalRates();
  const { data: status } = useIntegrationStatus();
  // Managers only — the endpoint refuses anyone below, and asking would just
  // put a 403 in the console on a page a salesperson is allowed to read.
  const { data: health } = useGoldRateHealth(canEdit);
  const setRate = useSetGoldRate();
  const refresh = useRefreshGoldRate();

  const [karat, setKarat] = useState<"22" | "24">("22");
  const [amount, setAmount] = useState("");

  const feedOn = status?.goldRate ?? false;
  const goldRows = (rates ?? []).filter((r) => SHOWN.includes(r.metal));

  function submit() {
    const ratePerGram = Number(amount);
    if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
      toast.error("Enter a valid gold rate");
      return;
    }
    setRate.mutate(
      { ratePerGram, karat: Number(karat) as 22 | 24 },
      {
        onSuccess: () => {
          toast.success("Today's gold rate saved — new quotes use it now.");
          setAmount("");
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save the rate")),
      },
    );
  }

  function pull() {
    refresh.mutate(undefined, {
      onSuccess: (r) => {
        if (r.updated) toast.success("Pulled the latest rate from the feed.");
        else toast.message("No feed returned a price — set the rate by hand.");
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Couldn't pull the rate")),
    });
  }

  return (
    <div>
      <SectionHeader title={nav.title} purpose={nav.purpose} />

      <MetalRatesWidget className="mb-6" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Today&apos;s rates</CardTitle>
            <CardDescription>What every new quote is priced from.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full rounded-lg" />)
            ) : goldRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No gold rate on record yet — set one{canEdit ? " on the right" : ""}.
              </p>
            ) : (
              goldRows.map((r) => (
                <div
                  key={r.metal}
                  className="flex items-center justify-between rounded-lg border px-3 py-2.5"
                >
                  <span className="text-sm font-medium text-foreground">
                    {METAL_LABEL[r.metal] ?? r.metal}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="num text-sm font-semibold text-foreground">
                      {formatINR(r.ratePerGram)}/g
                    </span>
                    <Badge variant={r.stale ? "warning" : "success"}>
                      {r.stale ? staleNote(r) : ageLabel(r.ageHours)}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle>Set today&apos;s rate</CardTitle>
              <CardDescription>
                Enter the morning rate you quote at — 24K and 18K are derived
                automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3">
                <div className="w-28 space-y-1.5">
                  <Label>Purity</Label>
                  <Select
                    value={karat}
                    onValueChange={(v) => setKarat(v as "22" | "24")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="22">22K</SelectItem>
                      <SelectItem value="24">24K</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="rate">Rate (₹ / gram)</Label>
                  <Input
                    id="rate"
                    inputMode="decimal"
                    placeholder="e.g. 6600"
                    value={amount}
                    onChange={(e) => setAmount(positiveNumberInput(e.target.value))}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="gold" onClick={submit} disabled={setRate.isPending}>
                  {setRate.isPending ? "Saving…" : "Save today's rate"}
                </Button>
                {feedOn ? (
                  <Button
                    variant="outline"
                    onClick={pull}
                    disabled={refresh.isPending}
                  >
                    <RefreshCw
                      className={cn("h-4 w-4", refresh.isPending && "animate-spin")}
                    />
                    Pull from feed
                  </Button>
                ) : null}
              </div>

              <p className="text-xs text-muted-foreground">
                {feedOn
                  ? "A live feed is connected — it refreshes from the market on its own through the day. Setting a rate here overrides it until the next pull."
                  : "No live feed is connected yet, so the rate won't move on its own. Set it here, or connect a feed for automatic updates."}
              </p>

              {/*
                Whether anything is actually pulling.
                A price's age is already on every row, but age alone cannot tell
                a quiet market from a refresh that stopped running — and those
                need opposite responses. Pressing "Pull from feed" fixes the
                first and does nothing for the second.
              */}
              {health ? (
                <p
                  className={cn(
                    "text-xs",
                    health.overdue ? "text-[var(--warning)]" : "text-muted-foreground",
                  )}
                >
                  {health.lastRunAt === null ? (
                    <>
                      <strong>The automatic refresh has never run here.</strong> Rates
                      will only change when someone sets them by hand. If that is
                      unexpected, the scheduler is not running on this environment.
                    </>
                  ) : health.overdue ? (
                    <>
                      <strong>
                        Automatic refresh last ran {refreshAge(health.ageHours)}
                      </strong>{" "}
                      — longer ago than it should. Rates are not updating on their
                      own; check that the scheduler is running.
                    </>
                  ) : (
                    <>
                      Automatic refresh ran {refreshAge(health.ageHours)}
                      {health.lastRunUpdated === false
                        ? " — the source had nothing newer."
                        : "."}{" "}
                      Source: {health.source === "ibja" ? "IBJA" : "custom feed"}.
                    </>
                  )}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            icon={Coins}
            title="View only"
            description="Ask a manager to update today's gold rate."
          />
        )}
      </div>
    </div>
  );
}
