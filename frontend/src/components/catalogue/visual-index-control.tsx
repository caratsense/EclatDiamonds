"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useReindexStatus, useStartReindex } from "@/lib/queries/jewelry-similarity";
import { apiErrorMessage } from "@/lib/utils";

const time = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

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

  let line = "Rebuild after a bulk import, or when image search says the catalogue isn't indexed.";
  if (running) {
    line = status?.total
      ? `Rebuilding — ${status.done ?? 0} of ${status.total} photos (started ${time(status.startedAt)})`
      : `Rebuilding — reading photos (started ${time(status?.startedAt)})`;
  } else if (status?.error) {
    line = `Last rebuild failed (${time(status.finishedAt)}): ${status.error}`;
  } else if (status?.result) {
    const r = status.result;
    line = `Last rebuilt ${time(status.finishedAt)} — ${r.embedded ?? 0} indexed, ${r.skipped ?? 0} already current, ${r.failed ?? 0} unreadable`;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
      <p className="text-xs text-muted-foreground">
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
              toast.success(d.started ? "Rebuild started — this page shows its progress" : "A rebuild is already running"),
            onError: (err) => toast.error(apiErrorMessage(err, "Could not start the rebuild.")),
          })
        }
      >
        {running || start.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Rebuild index
      </Button>
    </div>
  );
}
