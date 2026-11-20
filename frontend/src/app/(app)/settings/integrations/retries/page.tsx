"use client";

import Link from "next/link";
import { CheckCircle2, RotateCcw } from "lucide-react";
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
  isManuallyRetryable,
  useOutbox,
  useRetryMessage,
} from "@/lib/queries/meta-admin";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Screen 7 — the messages a person can actually do something about.
 *
 * The outbox shows everything; this shows only what a retry would move. A
 * delivered message must never be sent twice, and a job still pending or running
 * will move on its own — offering a button for either would invite somebody to
 * double-send to a customer or to add work that is already queued.
 */
export default function ManualRetryPage() {
  const outbox = useOutbox();
  const retry = useRetryMessage();

  const eligible = (outbox.data ?? []).filter(isManuallyRetryable);

  return (
    <>
      <AdminPageHeader
        title="Waiting for a person"
        purpose="Outbound messages that will not move on their own. Everything else is either finished or already queued."
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/integrations/outbox">All outbound messages</Link>
          </Button>
        }
      />

      {outbox.isLoading ? (
        <LoadingBlock />
      ) : outbox.isError ? (
        <LoadFailed message={apiErrorMessage(outbox.error, "The outbox could not be read.")} />
      ) : eligible.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nothing is stuck"
          description="Every outbound message is either delivered or already attached to a delivery job that will run on its own."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{eligible.length} message(s) need attention</CardTitle>
            <p className="text-xs text-muted-foreground">
              Fix the cause first — a missing connection, a template the provider withdrew — then
              retry. Retrying without fixing it just repeats the same failure.
            </p>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Why it stopped</TableHead>
                  <TableHead>Composed</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eligible.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      {row.conversation?.party?.name ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {row.conversation?.channel ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={row.status === "failed" ? "destructive" : "outline"}>
                          {OUTBOX_STATUS_LABEL[row.status]}
                        </Badge>
                        <p className="max-w-md text-xs text-muted-foreground">
                          {row.error ??
                            row.job?.lastError ??
                            (row.job
                              ? `The delivery job is ${row.job.status} after ${row.job.attempts} attempt(s).`
                              : "No delivery job has been attached to this message yet.")}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {when(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() =>
                          retry.mutate(row.id, {
                            onSuccess: () => toast.success("Queued for another attempt."),
                            onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
                          })
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
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
