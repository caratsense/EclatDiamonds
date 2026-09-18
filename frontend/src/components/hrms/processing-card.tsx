"use client";

import { useState } from "react";
import { Cog } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useProcessingRuns,
  useStartProcessingRun,
} from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const ALL = "__all";
const day = (s: string) => s.slice(0, 10);

/**
 * Head office: rebuild the register from the raw punches, leave, holidays and
 * week-offs for a date range. Locked payroll months are skipped and counted.
 */
export function ProcessingCard() {
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  const runs = useProcessingRuns();
  const start = useStartProcessingRun();
  const today = new Date().toLocaleDateString("en-CA");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [storeId, setStoreId] = useState("");

  function run() {
    if (!from || !to || from > to) {
      toast.error("Pick a valid date range.");
      return;
    }
    start.mutate(
      { from, to, storeId: storeId || undefined },
      {
        onSuccess: (r) =>
          toast.success("Processing finished", {
            description: `${r.processed} days checked, ${r.changed} changed, ${r.skippedLocked} skipped (locked).`,
          }),
        onError: (err) => toast.error(apiErrorMessage(err, "Processing failed.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cog className="h-4 w-4 text-muted-foreground" />
          Reprocess attendance
        </CardTitle>
        <CardDescription>
          Recompute days from the punch log, leave, holidays and week-offs. Locked
          payroll months are left alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pr-from">From</Label>
            <Input id="pr-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pr-to">To</Label>
            <Input id="pr-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pr-store">Store</Label>
            <Select value={storeId || ALL} onValueChange={(v) => setStoreId(v === ALL ? "" : v)}>
              <SelectTrigger id="pr-store">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All stores</SelectItem>
                {stores.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={run} disabled={start.isPending}>
          {start.isPending ? "Processing…" : "Run processing"}
        </Button>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Recent runs</p>
          {runs.isLoading ? (
            <Skeleton className="h-14 rounded-lg" />
          ) : runs.isError ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load runs.{" "}
              <button type="button" className="underline" onClick={() => runs.refetch()}>
                Retry
              </button>
            </p>
          ) : (runs.data ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
              No processing runs yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {(runs.data ?? []).map((r) => (
                <li key={r.id} className="rounded-lg border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="num">
                      {day(r.fromDate)} → {day(r.toDate)}
                    </span>
                    <Badge
                      variant={
                        r.status === "done" ? "success" : r.status === "failed" ? "destructive" : "secondary"
                      }
                    >
                      {r.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.storeName ?? (r.storeId ? "One store" : "All stores")} ·{" "}
                    {new Date(r.startedAt).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                  <p className="num text-xs">
                    {r.processed} processed · {r.changed} changed · {r.skippedLocked} skipped (locked)
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
