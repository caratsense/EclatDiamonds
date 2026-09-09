"use client";

import { useState } from "react";
import {
  Ban,
  Clock,
  Database,
  Loader2,
  RefreshCw,
  ServerCog,
  Wifi,
  WifiOff,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnectorRuntime, type ConnectorRuntimeRow } from "@/lib/queries/tenant-config";
import { useSourceDiscovery } from "@/lib/queries/imports";
import type { FileImportOrigin } from "@/lib/queries/imports";
import { IntakeBadge } from "@/components/data/import-wizard";

/**
 * Where this organisation's data comes from.
 *
 * The rule this screen exists to honour: a "Sync now" button appears ONLY when
 * `runnable` is true. Gati is agent-push — the on-site agent decides when to
 * send, and CaratOS never reaches into a customer's network — so offering a
 * pull button there would be offering a button that can only ever fail. Instead
 * the panel shows what the agent has actually delivered and how fresh it is,
 * which is the question someone opening this screen is really asking.
 */
export function SourcePanel({
  onImportFile,
}: {
  onImportFile: (entity?: string, sourceSystem?: FileImportOrigin) => void;
}) {
  const { data: sources, isLoading, isError, refetch } = useConnectorRuntime();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (isError || !sources) {
    return (
      <EmptyState
        icon={WifiOff}
        title="Could not load your data sources"
        description="The connector registry did not respond."
        actionLabel="Try again"
        onAction={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-3">
      {sources.map((s) => (
        <SourceCard
          key={s.sourceSystem}
          source={s}
          expanded={expanded === s.sourceSystem}
          onToggle={() =>
            setExpanded((cur) => (cur === s.sourceSystem ? null : s.sourceSystem))
          }
          onImportFile={onImportFile}
        />
      ))}
    </div>
  );
}

function SourceCard({
  source,
  expanded,
  onToggle,
  onImportFile,
}: {
  source: ConnectorRuntimeRow;
  expanded: boolean;
  onToggle: () => void;
  onImportFile: (entity?: string, sourceSystem?: FileImportOrigin) => void;
}) {
  const configured = source.status === "connected";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
            {source.name}
            <IntakeBadge mode={source.intakeMode} />
            {configured ? (
              <Badge variant="secondary" className="gap-1">
                <Wifi className="h-3 w-3" />
                Available
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Ban className="h-3 w-3" />
                Not configured
              </Badge>
            )}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{source.description}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {source.intakeMode === "file_upload" ? (
            <Button
              size="sm"
              onClick={() => onImportFile(source.entities[0], "spreadsheet")}
            >
              Import a file
            </Button>
          ) : source.fileImportFallback ? (
            <Button
              size="sm"
              onClick={() => onImportFile(undefined, source.fileImportFallback?.sourceSystem)}
            >
              Import an export
            </Button>
          ) : null}
          {configured && source.intakeMode !== "file_upload" ? (
            <Button size="sm" variant="outline" onClick={onToggle}>
              {expanded ? "Hide" : "Status"}
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* The honest reason, verbatim from the server, in place of an action. */}
        {!source.runnable && source.notRunnableReason && (
          <p className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            {source.notRunnableReason}
          </p>
        )}

        {source.fileImportFallback ? (
          <p className="rounded-lg border border-emerald-600/30 bg-emerald-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Available now: </span>
            {source.fileImportFallback.note}
          </p>
        ) : null}

        {source.entities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {source.entities.map((e) => (
              <Badge key={e} variant="outline" className="text-[11px] font-normal">
                {e}
              </Badge>
            ))}
          </div>
        )}

        {expanded && <SourceStatus sourceSystem={source.sourceSystem} />}
      </CardContent>
    </Card>
  );
}

/** Live delivery status for a non-file source: what has arrived, and when. */
function SourceStatus({ sourceSystem }: { sourceSystem: string }) {
  const { data, isLoading, isError, refetch, isFetching } = useSourceDiscovery(sourceSystem);

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError || !data) {
    return (
      <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
        Could not read the delivery status for this source.
      </p>
    );
  }

  const watermarks = data.watermarks ?? [];
  const lastRun = watermarks
    .map((w) => w.lastRunAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ServerCog className="h-3.5 w-3.5" />
          {data.note}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {lastRun && (
        <p className="flex items-center gap-1.5 text-xs">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">Last delivery</span>
          <span className="text-muted-foreground">
            {new Date(lastRun).toLocaleString()} ({freshness(lastRun)})
          </span>
        </p>
      )}

      {watermarks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing has been delivered yet. Until the agent runs, this source has no data
          here — that is a real state, not a loading one.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] text-xs">
            <thead>
              <tr className="border-b text-left uppercase tracking-wide text-muted-foreground">
                <th className="pb-1.5 pr-3 font-medium">Source table</th>
                <th className="pb-1.5 pr-3 font-medium">Rows</th>
                <th className="pb-1.5 pr-3 font-medium">Watermark</th>
                <th className="pb-1.5 font-medium">Last run</th>
              </tr>
            </thead>
            <tbody>
              {watermarks.map((w) => (
                <tr key={`${w.sourceTable}:${w.storeId ?? "all"}`} className="border-b last:border-0">
                  {/* The source's own table names, not renamed into friendlier
                      ones — these have to match what the agent logs or they are
                      useless when someone is working out why a sync stalled. */}
                  <td className="py-1.5 pr-3 font-mono">{w.sourceTable}</td>
                  <td className="num py-1.5 pr-3">{w.rowsSynced}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                    {w.lastLegacyId ?? w.lastUpdatedAt?.slice(0, 10) ?? "—"}
                  </td>
                  <td className="py-1.5 text-muted-foreground">
                    {w.lastRunAt ? new Date(w.lastRunAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.blocked && data.blockedReason && (
        <p className="text-xs text-muted-foreground">{data.blockedReason}</p>
      )}
    </div>
  );
}

/** Plain-language freshness. Deliberately vague past a week — precision there is noise. */
function freshness(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (hours < 1) return "within the hour";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days <= 7 ? `${days}d ago` : "over a week ago";
}
