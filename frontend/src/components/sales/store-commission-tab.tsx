"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR, formatPercent } from "@/lib/format";
import {
  useCommissionSummary,
  useUpsertCommissionPlan,
  type StoreCommissionRow,
} from "@/lib/queries/commissions";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";

/** Current calendar month as the "YYYY-MM" the month input expects. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Store Commission (client 9 Oct item 13) — the STORE's monthly commission:
 * max(0, qualifying sales − threshold) × rate. Threshold + rate are per-store
 * head-office configuration; managers read the breakdown for their store(s).
 * Distinct from the per-staff incentive table on the other tab and from the
 * customer referral credit.
 */
export function StoreCommissionTab({ canConfigure }: { canConfigure: boolean }) {
  const [month, setMonth] = useState(currentMonth);
  const query = useCommissionSummary(month);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="commission-month">Month</Label>
          <Input
            id="commission-month"
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="w-full sm:w-auto"
          />
        </div>
        <p className="max-w-xl text-xs text-muted-foreground">
          Qualifying sales are the store&apos;s billed sales for the calendar
          month (store timezone), minus billed sale returns; cancelled bills are
          excluded. A return request not yet billed as a sale return does not
          reduce the figure. Commission = (qualifying sales − threshold) × rate,
          never below zero.
        </p>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : query.isError ? (
        <Card>
          <CardContent className="space-y-2 p-6 text-center">
            <p className="text-sm font-medium">
              Couldn&apos;t load the commission summary.
            </p>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(query.data ?? []).map((row) => (
            <StoreCommissionCard
              key={row.storeId}
              row={row}
              canConfigure={canConfigure}
            />
          ))}
          {(query.data ?? []).length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                No stores in scope.
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`num text-sm ${emphasis ? "font-semibold" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function StoreCommissionCard({
  row,
  canConfigure,
}: {
  row: StoreCommissionRow;
  canConfigure: boolean;
}) {
  const hasActivePlan = !!row.plan?.isActive;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{row.storeName}</CardTitle>
          {row.plan ? (
            <Badge variant={row.plan.isActive ? "default" : "outline"}>
              {row.plan.isActive
                ? `${formatINR(row.plan.threshold)} at ${formatPercent(row.plan.ratePercent, 2)}`
                : "Plan paused"}
            </Badge>
          ) : (
            <Badge variant="outline">No plan configured</Badge>
          )}
        </div>
        <CardDescription>
          Store commission for {row.month} — sales net of billed returns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <BreakdownRow label="Billed sales" value={formatINR(row.sales)} />
          <BreakdownRow
            label="Sale returns"
            value={`− ${formatINR(row.returns)}`}
          />
          <BreakdownRow
            label="Qualifying sales"
            value={formatINR(row.qualifyingSales)}
            emphasis
          />
          {hasActivePlan && row.plan ? (
            <>
              <BreakdownRow
                label="Threshold"
                value={formatINR(row.plan.threshold)}
              />
              <BreakdownRow
                label="Excess over threshold"
                value={formatINR(row.excess ?? 0)}
              />
              <BreakdownRow
                label={`Commission (${formatPercent(row.plan.ratePercent, 2)} of excess)`}
                value={formatINR(row.commission ?? 0)}
                emphasis
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {row.plan
                ? "The plan is paused — no commission is computed for this month."
                : "Head office has not set a threshold and rate for this store yet."}
            </p>
          )}
        </div>
        {canConfigure ? <PlanEditor row={row} /> : null}
      </CardContent>
    </Card>
  );
}

/** Head-office inline editor: threshold (₹) + rate (%) + active, PUT on save. */
function PlanEditor({ row }: { row: StoreCommissionRow }) {
  const upsert = useUpsertCommissionPlan();
  const [threshold, setThreshold] = useState<string>(
    row.plan ? String(row.plan.threshold) : "",
  );
  const [rate, setRate] = useState<string>(
    row.plan ? String(row.plan.ratePercent) : "",
  );
  const [active, setActive] = useState<boolean>(row.plan?.isActive ?? true);

  const parsedThreshold = Number.parseFloat(threshold);
  const parsedRate = Number.parseFloat(rate);
  const valid =
    Number.isFinite(parsedThreshold) &&
    parsedThreshold >= 0 &&
    Number.isFinite(parsedRate) &&
    parsedRate >= 0 &&
    parsedRate <= 100;

  function save() {
    if (!valid) {
      toast.error("Enter a threshold ≥ ₹0 and a rate between 0 and 100%.");
      return;
    }
    upsert.mutate(
      {
        storeId: row.storeId,
        threshold: parsedThreshold,
        ratePercent: parsedRate,
        isActive: active,
      },
      {
        onSuccess: (plan) =>
          toast.success(`Plan saved for ${plan.storeName}`, {
            description: `${formatINR(plan.threshold)} threshold at ${formatPercent(plan.ratePercent, 2)}${plan.isActive ? "" : " (paused)"}.`,
          }),
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not save the plan.")),
      },
    );
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs font-medium">Configure plan (head office)</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label
            htmlFor={`threshold-${row.storeId}`}
            className="text-xs text-muted-foreground"
          >
            Monthly threshold (₹)
          </Label>
          <Input
            id={`threshold-${row.storeId}`}
            inputMode="decimal"
            className="num h-8 w-36"
            value={threshold}
            onChange={(e) => setThreshold(positiveNumberInput(e.target.value))}
          />
        </div>
        <div className="grid gap-1">
          <Label
            htmlFor={`rate-${row.storeId}`}
            className="text-xs text-muted-foreground"
          >
            Rate (%)
          </Label>
          <Input
            id={`rate-${row.storeId}`}
            inputMode="decimal"
            className="num h-8 w-20"
            value={rate}
            onChange={(e) => setRate(positiveNumberInput(e.target.value))}
          />
        </div>
        <label className="flex h-8 items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Active
        </label>
        <Button
          size="sm"
          className="h-8"
          disabled={upsert.isPending}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
