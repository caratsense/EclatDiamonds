"use client";

import { useState } from "react";
import Link from "next/link";
import { Inbox, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import {
  AdminPageHeader,
  LoadFailed,
  LoadingBlock,
  when,
} from "@/components/integrations/admin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  OUTBOX_STATUS_LABEL,
  useOutbox,
  useSweepOutbox,
  type OutboxRow,
  type OutboxStatus,
} from "@/lib/queries/meta-admin";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const FILTERS: Array<{ value: OutboxStatus | "all"; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "queued", label: "Waiting to send" },
  { value: "failed", label: "Failed" },
  { value: "sent", label: "Sent" },
  { value: "delivered", label: "Delivered" },
  { value: "read", label: "Read" },
];

const STATUS_VARIANT: Record<OutboxStatus, "success" | "warning" | "destructive" | "outline"> = {
  queued: "outline",
  sent: "success",
  delivered: "success",
  read: "success",
  failed: "destructive",
};

/**
 * Screen 6 — every outbound message, in the state it is really in.
 *
 * "Waiting to send" is not "sent". A message can sit here with nothing wrong
 * with it because no messaging account is connected for its channel, and saying
 * "sent" in that case would be a lie a salesperson repeats to a customer. The
 * delivery job behind each row is shown beside it, because "the message failed"
 * and "the job that carries it failed" are different problems.
 */
export default function OutboxPage() {
  const [filter, setFilter] = useState<OutboxStatus | "all">("all");
  const outbox = useOutbox(filter === "all" ? undefined : filter);
  const sweep = useSweepOutbox();
  const role = useSession((s) => s.role);
  const canSweep = role === "head_office" || role === "store_manager";

  return (
    <>
      <AdminPageHeader
        title="Outbound messages"
        purpose="What has left the building, what is waiting, and what failed on the way."
        action={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/integrations/retries">Needs a person</Link>
            </Button>
            {canSweep ? (
              <Button
                size="sm"
                disabled={sweep.isPending}
                onClick={() =>
                  sweep.mutate(undefined, {
                    onSuccess: (r: { created?: number }) =>
                      toast.success(
                        r?.created
                          ? `${r.created} message(s) attached to a delivery job.`
                          : "Nothing was waiting for a delivery job.",
                      ),
                    onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
                  })
                }
              >
                <RefreshCw className={`h-4 w-4 ${sweep.isPending ? "animate-spin" : ""}`} />
                Attach delivery jobs
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filter === f.value ? "default" : "outline"}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {outbox.isLoading ? (
        <LoadingBlock />
      ) : outbox.isError ? (
        <LoadFailed message={apiErrorMessage(outbox.error, "The outbox could not be read.")} />
      ) : (outbox.data ?? []).length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing in the outbox"
          description={
            filter === "all"
              ? "No outbound message has been composed for the locations you can see."
              : `No message is currently ${OUTBOX_STATUS_LABEL[filter as OutboxStatus].toLowerCase()}.`
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{outbox.data!.length} message(s)</CardTitle>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Delivery job</TableHead>
                  <TableHead>Composed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outbox.data!.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      {row.conversation?.party?.name ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {row.conversation?.channel ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <p className="truncate text-xs text-muted-foreground">{row.body ?? "—"}</p>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {OUTBOX_STATUS_LABEL[row.status]}
                        </Badge>
                        {row.error ? (
                          <p className="max-w-xs text-xs text-muted-foreground">{row.error}</p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <JobCell row={row} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {when(row.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function JobCell({ row }: { row: OutboxRow }) {
  if (!row.job) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Send className="h-3 w-3" />
        None attached
      </span>
    );
  }
  return (
    <div className="space-y-1">
      <span className="text-xs">
        {row.job.status} · attempt {row.job.attempts}
      </span>
      {row.job.lastError ? (
        <p className="max-w-xs text-xs text-muted-foreground">{row.job.lastError}</p>
      ) : null}
    </div>
  );
}
