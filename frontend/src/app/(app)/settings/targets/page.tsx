"use client";

import { useMemo, useState } from "react";
import { Lock, Target } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR, formatPercent } from "@/lib/format";
import {
  useSetTarget,
  useTargetAchievement,
  useTargets,
} from "@/lib/queries/targets";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage, cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** Current month as YYYY-MM (local). */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}`;
}

/** "2026-07" → "July 2026". */
function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Date(y, m - 1, 1).toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

interface EditTarget {
  storeId: string;
  storeName: string;
  amount: number;
}

export default function TargetsPage() {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const [period, setPeriod] = useState(currentMonth());
  const [edit, setEdit] = useState<EditTarget | null>(null);

  const achievement = useTargetAchievement(period);
  // Existing target rows — used only to surface whole-store amounts alongside
  // achievement (the achievement feed already carries the target number).
  useTargets(period);

  // Area-manager+ only. Guard the page for direct URL / demo role switches.
  if (!canView) {
    return (
      <>
        <SectionHeader
          title="Targets"
          purpose="Set monthly sales targets per store and track achievement."
        />
        <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Area Manager &amp; above only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sales targets are set by Area Managers and Head Office. Switch to a
            higher-level view to continue.
          </p>
        </div>
      </>
    );
  }

  const rows = achievement.data ?? [];
  const totals = rows.reduce(
    (acc, r) => {
      acc.target += r.target;
      acc.achieved += r.achieved;
      return acc;
    },
    { target: 0, achieved: 0 },
  );
  const totalPct = totals.target > 0 ? (totals.achieved / totals.target) * 100 : 0;

  return (
    <>
      <SectionHeader
        title="Targets"
        purpose="Set monthly sales targets per store and track achievement."
      />

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Monthly targets</CardTitle>
            <CardDescription>
              Store targets for {monthLabel(period)}. Set a whole-store target;
              achievement updates as sales are recorded.
            </CardDescription>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="target-period">Month</Label>
            <Input
              id="target-period"
              type="month"
              className="w-[180px]"
              value={period}
              onChange={(e) => setPeriod(e.target.value || currentMonth())}
            />
          </div>
        </CardHeader>
        <CardContent>
          {achievement.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : achievement.isError ? (
            <div className="mx-auto max-w-sm rounded-lg border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
              <p>Couldn&apos;t load targets.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => achievement.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                <Target className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No stores in scope</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Targets appear per store once stores are configured.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead className="text-right">Target</TableHead>
                  <TableHead className="text-right">Achieved</TableHead>
                  <TableHead className="w-[220px]">Achievement</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.storeId}>
                    <TableCell className="font-medium">{r.storeName}</TableCell>
                    <TableCell className="num text-right">
                      {r.target > 0 ? (
                        formatINR(r.target)
                      ) : (
                        <span className="text-muted-foreground">Not set</span>
                      )}
                    </TableCell>
                    <TableCell className="num text-right">
                      {formatINR(r.achieved)}
                    </TableCell>
                    <TableCell>
                      <AchievementBar
                        pct={r.target > 0 ? r.pct : 0}
                        hasTarget={r.target > 0}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={() =>
                          setEdit({
                            storeId: r.storeId,
                            storeName: r.storeName,
                            amount: r.target,
                          })
                        }
                      >
                        {r.target > 0 ? "Edit target" : "Set target"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">
                    All stores ({rows.length})
                  </TableCell>
                  <TableCell className="num text-right font-semibold">
                    {formatINR(totals.target)}
                  </TableCell>
                  <TableCell className="num text-right font-semibold">
                    {formatINR(totals.achieved)}
                  </TableCell>
                  <TableCell>
                    <AchievementBar
                      pct={totalPct}
                      hasTarget={totals.target > 0}
                    />
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      <SetTargetDialog
        period={period}
        edit={edit}
        onOpenChange={(open) => !open && setEdit(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */

function AchievementBar({ pct, hasTarget }: { pct: number; hasTarget: boolean }) {
  if (!hasTarget) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const clamped = Math.min(100, Math.max(0, pct));
  const tone =
    pct >= 100
      ? "bg-success"
      : pct >= 60
        ? "bg-[var(--gold)]"
        : "bg-warning";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span
        className={cn(
          "num w-12 shrink-0 text-right text-xs font-medium",
          pct >= 100 ? "text-success" : "text-muted-foreground",
        )}
      >
        {formatPercent(pct, 0)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SetTargetDialog({
  period,
  edit,
  onOpenChange,
}: {
  period: string;
  edit: EditTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const setTarget = useSetTarget();
  const [amount, setAmount] = useState("");
  // Re-seed the field whenever a different store's dialog opens.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (edit && edit.storeId !== seededId) {
    setSeededId(edit.storeId);
    setAmount(edit.amount > 0 ? String(edit.amount) : "");
  }
  if (!edit && seededId !== null) {
    setSeededId(null);
    setAmount("");
  }

  const parsed = Number(amount);
  const invalid = amount.trim() === "" || Number.isNaN(parsed) || parsed < 0;

  function save() {
    if (!edit) return;
    if (invalid) {
      toast.error("Enter a valid target amount.");
      return;
    }
    setTarget.mutate(
      { storeId: edit.storeId, period, amount: Math.round(parsed) },
      {
        onSuccess: () => {
          toast.success(`Target set for ${edit.storeName}.`);
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not save the target.")),
      },
    );
  }

  const preview = useMemo(
    () => (invalid ? null : formatINR(Math.round(parsed))),
    [invalid, parsed],
  );

  return (
    <Dialog open={!!edit} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {edit && edit.amount > 0 ? "Edit target" : "Set target"}
          </DialogTitle>
          <DialogDescription>
            {edit
              ? `Monthly sales target for ${edit.storeName} — ${monthLabel(
                  period,
                )}.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="target-amount">
            Target amount (₹) <span className="text-destructive">*</span>
          </Label>
          <Input
            id="target-amount"
            inputMode="numeric"
            placeholder="e.g. 2500000"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
            aria-invalid={invalid && amount.trim() !== ""}
          />
          {preview ? (
            <p className="num text-xs text-muted-foreground">{preview}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Whole-store target for the month.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={setTarget.isPending || invalid}>
            {setTarget.isPending ? "Saving…" : "Save target"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
