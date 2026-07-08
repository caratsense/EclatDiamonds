"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR, formatINRCompact, formatPercent } from "@/lib/format";
import type { CommissionRow } from "@/lib/mock/hrms";
import { useUpdateCommissionRate } from "@/lib/queries/hrms";

function AchievementBar({ pct }: { pct: number }) {
  const capped = Math.min(pct, 100);
  const hit = pct >= 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${hit ? "bg-emerald-500" : "bg-amber-500"}`}
          style={{ width: `${capped}%` }}
        />
      </div>
      <span className="num text-xs font-medium">{formatPercent(pct, 0)}</span>
    </div>
  );
}

/** Round to 2dp for stable dirty-checking against the persisted percent. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One commission row. When `canEdit`, the rate is an inline editable percent;
 * the incentive preview recomputes live as you type, and Save persists via
 * PATCH /hrms/commission/:id (backend recomputes the stored amount).
 */
function CommissionTableRow({
  row,
  canEdit,
}: {
  row: CommissionRow;
  canEdit: boolean;
}) {
  const updateRate = useUpdateCommissionRate();
  // Persisted rate is a fraction (0.012) → show/edit as a percent (1.2).
  const persistedPct = round2(row.rate * 100);
  const [pct, setPct] = useState<string>(String(persistedPct));

  const parsed = Number.parseFloat(pct);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
  const dirty = valid && round2(parsed) !== persistedPct;
  // While actively editing, preview the recomputed incentive; otherwise show the
  // authoritative server value.
  const shownIncentive =
    canEdit && dirty ? row.salesValue * (parsed / 100) : row.incentive;
  const targetPct = row.target ? (row.salesValue / row.target) * 100 : 0;

  function save() {
    if (!valid) {
      toast.error("Enter a rate between 0 and 100%.");
      setPct(String(persistedPct));
      return;
    }
    if (!dirty) return;
    updateRate.mutate(
      { id: row.id, rate: round2(parsed) },
      {
        onSuccess: (updated) =>
          toast.success(`Rate updated for ${updated.name}`, {
            description: `${formatPercent(updated.rate * 100, 2)} → incentive ${formatINR(
              updated.incentive,
            )}.`,
          }),
        onError: () => {
          toast.error("Could not update the rate.");
          setPct(String(persistedPct));
        },
      },
    );
  }

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium leading-tight">{row.name}</p>
        <p className="text-xs text-muted-foreground">{row.role}</p>
      </TableCell>
      <TableCell className="num text-right">{formatINR(row.salesValue)}</TableCell>
      <TableCell className="text-right">
        {canEdit ? (
          <div className="flex items-center justify-end gap-1.5">
            <div className="relative w-20">
              <Input
                type="number"
                min={0}
                max={100}
                step={0.1}
                inputMode="decimal"
                aria-label={`Commission rate for ${row.name} (percent)`}
                className="num h-8 pr-5 text-right"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
                onBlur={save}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
            {dirty ? (
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                aria-label="Save rate"
                disabled={updateRate.isPending}
                onClick={save}
              >
                <Check className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        ) : (
          <Badge variant="outline">
            <span className="num">{formatPercent(row.rate * 100, 1)}</span>
          </Badge>
        )}
      </TableCell>
      <TableCell className="num text-right font-medium">
        {formatINR(shownIncentive)}
      </TableCell>
      <TableCell className="num text-right text-muted-foreground">
        {formatINRCompact(row.target)}
      </TableCell>
      <TableCell>
        <AchievementBar pct={targetPct} />
      </TableCell>
    </TableRow>
  );
}

export function EditableCommissionTab({
  rows,
  canEdit,
}: {
  rows: CommissionRow[];
  canEdit: boolean;
}) {
  const totalIncentive = rows.reduce((s, r) => s + r.incentive, 0);
  const totalSales = rows.reduce((s, r) => s + r.salesValue, 0);
  const achievers = rows.filter((r) => r.salesValue >= r.target).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Attributed sales</p>
            <p className="num text-2xl font-semibold">
              {formatINRCompact(totalSales)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Payable incentive</p>
            <p className="num text-2xl font-semibold">
              {formatINRCompact(totalIncentive)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Target achievers</p>
            <p className="num text-2xl font-semibold">
              {achievers}/{rows.length}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Commission engine</CardTitle>
          <CardDescription>
            Incentive = attributed sales × rate.{" "}
            {canEdit
              ? "Edit a rate inline — the incentive recomputes and saves."
              : "Rates are set by your store manager."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff</TableHead>
                <TableHead className="text-right">Sales value</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Incentive</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead>Achievement</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No commission attributed yet — close a sale to start earning.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((r) => (
                // Remount when the persisted rate changes so the input resyncs
                // after a save + refetch.
                <CommissionTableRow
                  key={`${r.id}-${r.rate}`}
                  row={r}
                  canEdit={canEdit}
                />
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className="num text-right">
                  {formatINR(totalSales)}
                </TableCell>
                <TableCell />
                <TableCell className="num text-right">
                  {formatINR(totalIncentive)}
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
