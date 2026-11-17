"use client";

import { useState } from "react";
import { AlertTriangle, Boxes, HelpCircle, Package } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getNavItem } from "@/lib/navigation";
import {
  STOCK_SOURCES,
  STOCK_SOURCE_LABELS,
  type StockSource,
  type StoreStockRow,
  useStockByStore,
} from "@/lib/queries/stock-by-store";
import { cn } from "@/lib/utils";

/**
 * Stock as each branch holds it, and whether its data can be trusted.
 *
 * The client could not answer two questions from the inventory screens: what
 * does this branch actually have, and is that number real? A store that never
 * synced looked exactly like a store that had sold everything, and 3,512
 * pieces whose branch Gati never named were invisible.
 *
 * So each row carries its own evidence, and the two states that used to look
 * identical are now coloured and worded differently.
 */

const STATE_COPY: Record<
  StoreStockRow["dataState"],
  { label: string; tone: string; hint: string }
> = {
  synced: {
    label: "Data received",
    tone: "bg-success/15 text-success",
    hint: "Pieces have arrived for this branch. A zero here is a real zero.",
  },
  no_data: {
    label: "No data received",
    tone: "bg-warning/15 text-warning",
    hint: "Nothing has ever arrived for this branch. This is NOT the same as having no stock.",
  },
  unmapped_holding: {
    label: "Unmapped",
    tone: "bg-destructive/15 text-destructive",
    hint: "Pieces whose branch was never named. They belong somewhere — someone has to say where.",
  },
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";

export default function StockByStorePage() {
  const nav = getNavItem("inventory/by-store");
  const [source, setSource] = useState<StockSource | undefined>();
  const { data, isLoading } = useStockByStore(source);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={nav?.title ?? "Stock by Store"}
        purpose={nav?.purpose ?? ""}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {/*
              A source filter asks where a piece CAME FROM. It deliberately
              does not change which store a row is about — the client's notes
              are explicit that provenance and location are different facts.
            */}
            <Button
              size="sm"
              variant={source ? "outline" : "default"}
              onClick={() => setSource(undefined)}
            >
              All sources
            </Button>
            {STOCK_SOURCES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={source === s ? "default" : "outline"}
                onClick={() => setSource(s)}
              >
                {STOCK_SOURCE_LABELS[s]}
              </Button>
            ))}
          </div>
        }
      />

      {isLoading ? <Skeleton className="h-64 w-full" /> : null}

      {!isLoading && data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile icon={Package} label="In stock now" value={data.totals.inStock} />
            <Tile
              icon={Boxes}
              label="Reserved by a transfer"
              value={data.totals.reserved}
              hint="In flight — counted in neither branch."
            />
            <Tile
              icon={AlertTriangle}
              label="Unmapped pieces"
              value={data.totals.unmapped}
              tone={data.totals.unmapped > 0 ? "text-destructive" : undefined}
              hint="Branch never named. Needs a correction, not a guess."
            />
          </div>

          {/*
            Said plainly rather than dressed up as a per-store timestamp.
            SyncState is modelled per store and the agent writes one row for
            the whole organisation, so a per-branch time would be invented.
          */}
          <p className="text-xs text-muted-foreground">
            {data.syncEvidence.lastRunAt
              ? `Last sync ${new Date(data.syncEvidence.lastRunAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} across ${data.syncEvidence.tables} tables.`
              : "No sync has been recorded yet."}
            {data.syncEvidence.scope === "organisation"
              ? " This is the whole organisation's sync, not per branch — the sync agent does not record a per-branch time."
              : ""}
          </p>

          {data.rows.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No branches to show"
              description="No store is visible to you, or none has any stock recorded."
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="p-3">Branch</th>
                        <th className="p-3">Data</th>
                        <th className="p-3 text-right">In stock</th>
                        <th className="p-3 text-right">Reserved</th>
                        <th className="p-3 text-right">Sold</th>
                        <th className="p-3 text-right">Moved out</th>
                        <th className="p-3 text-right">Ever recorded</th>
                        <th className="p-3">Source</th>
                        <th className="p-3">Latest record</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <Row key={r.storeId} r={r} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Package;
  label: string;
  value: number;
  hint?: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone)}>
          {value.toLocaleString("en-IN")}
        </div>
        {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Row({ r }: { r: StoreStockRow }) {
  const state = STATE_COPY[r.dataState];
  return (
    <tr className="border-b align-top last:border-0">
      <td className="min-w-0 p-3">
        <div className="font-medium break-words">{r.storeName}</div>
      </td>
      <td className="p-3">
        <Badge className={cn("font-medium", state.tone)} title={state.hint}>
          {state.label}
        </Badge>
      </td>
      <td className="p-3 text-right tabular-nums font-medium">
        {/* A branch with no data shows a dash, never a zero: the whole point. */}
        {r.dataState === "no_data" ? (
          <span className="text-muted-foreground" title={state.hint}>
            —
          </span>
        ) : (
          r.inStock.toLocaleString("en-IN")
        )}
      </td>
      <td className="p-3 text-right tabular-nums text-muted-foreground">
        {r.reserved ? r.reserved.toLocaleString("en-IN") : "—"}
      </td>
      <td className="p-3 text-right tabular-nums text-muted-foreground">
        {r.sold.toLocaleString("en-IN")}
      </td>
      <td className="p-3 text-right tabular-nums text-muted-foreground">
        {r.transferredOut.toLocaleString("en-IN")}
      </td>
      <td className="p-3 text-right tabular-nums text-muted-foreground">
        {r.everRecorded.toLocaleString("en-IN")}
      </td>
      <td className="p-3">
        <div className="flex flex-wrap gap-1">
          {STOCK_SOURCES.filter((s) => r.bySource[s] > 0).map((s) => (
            <Badge key={s} variant="secondary" className="text-[11px] font-normal">
              {STOCK_SOURCE_LABELS[s]} {r.bySource[s].toLocaleString("en-IN")}
            </Badge>
          ))}
          {STOCK_SOURCES.every((s) => r.bySource[s] === 0) ? (
            <span className="text-xs text-muted-foreground">
              <HelpCircle className="mr-1 inline h-3 w-3" />
              none
            </span>
          ) : null}
        </div>
      </td>
      <td className="p-3 text-xs text-muted-foreground">{when(r.lastRecordAt)}</td>
    </tr>
  );
}
