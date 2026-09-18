"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useReindexStatus, useStartReindex } from "@/lib/queries/jewelry-similarity";
import { apiErrorMessage, cn } from "@/lib/utils";

/**
 * Head office's handle on the visual-search index.
 *
 * New or changed photos index themselves one design at a time. This is for the
 * cases that touch everything: a bulk import from Gati or the website, and an
 * upgrade of the matching pipeline itself — which is exactly when a design
 * nobody has touched needs its photos redone. Unchanged photos are skipped, so
 * pressing it costs only what actually needs doing.
 */
export function VisualIndexControl() {
  const { data: status } = useReindexStatus(true);
  const start = useStartReindex();
  const running = Boolean(status?.running);
  const total = status?.total ?? 0;
  const done = status?.done ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const failed = (status?.counts?.failed ?? 0) + (status?.counts?.dead ?? 0);
  let line = "Rebuild after a bulk import, or when image search says the catalogue isn't indexed.";
  if (running) {
    line = total
      ? `Indexing — ${done} of ${total} photos · ${pct}%. Search keeps working meanwhile.`
      : "Indexing is queued…";
  } else if (status?.error) {
    line = `Last rebuild failed: ${status.error}`;
  } else if (total) {
    line = `${done} of ${total} photos indexed${failed ? ` · ${failed} could not be read` : ""}. Queues only what is not current.`;
  }

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border px-3 py-2",
        running ? "border-primary/40 bg-primary/[0.04]" : "border-dashed",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : null}
          <span className="font-medium text-foreground">Visual search index · </span>
          {line}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={running || start.isPending}
          onClick={() =>
            start.mutate(undefined, {
              onSuccess: (d) =>
                toast.success(
                  d.started ? `${d.queued ?? "Photos"} queued for indexing` : "Everything is already indexed or queued",
                ),
              onError: (err) => toast.error(apiErrorMessage(err, "Could not start the rebuild.")),
            })
          }
        >
          {running || start.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {running ? "Rebuilding…" : "Rebuild index"}
        </Button>
      </div>
      {running ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Visual search index rebuild"
        >
          <div
            className={cn("h-full rounded-full bg-primary transition-all", !total && "w-1/4 animate-pulse")}
            style={total ? { width: `${Math.max(pct, 2)}%` } : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
