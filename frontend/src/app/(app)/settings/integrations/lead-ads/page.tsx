"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  AdminPageHeader,
  LoadFailed,
  LoadingBlock,
  RequiresHeadOffice,
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
import { useJobsByKind, useRetryJob, type DurableJob } from "@/lib/queries/meta-admin";
import { apiErrorMessage } from "@/lib/utils";

const LEAD_FETCH = "meta.lead_ads.fetch";

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "outline"> = {
  succeeded: "success",
  pending: "outline",
  running: "outline",
  failed: "warning",
  dead: "destructive",
};

/**
 * Screen 8 — lead capture that did not arrive.
 *
 * Every submitted lead form is a person who asked to be contacted, so a fetch
 * that dead-letters is a lost customer rather than a log line. This screen is
 * deliberately loud about the difference between "will retry on its own" and
 * "has given up and needs somebody": the second is the only one worth
 * interrupting a day for.
 */
export default function LeadAdsFailuresPage() {
  return (
    <>
      <AdminPageHeader
        title="Lead capture failures"
        purpose="Lead form submissions the provider sent that could not be turned into a customer record."
      />
      <RequiresHeadOffice>
        <LeadAdsFailures />
      </RequiresHeadOffice>
    </>
  );
}

function LeadAdsFailures() {
  const [onlyProblems, setOnlyProblems] = useState(true);
  const jobs = useJobsByKind(LEAD_FETCH);
  const retry = useRetryJob();

  const all = jobs.data ?? [];
  const dead = all.filter((j) => j.status === "dead");
  const failing = all.filter((j) => j.status === "failed");
  const rows = onlyProblems ? [...dead, ...failing] : all;

  if (jobs.isLoading) return <LoadingBlock />;
  if (jobs.isError) return <LoadFailed message={apiErrorMessage(jobs.error, "The job list could not be read.")} />;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Given up"
          value={dead.length}
          tone={dead.length ? "bad" : "ok"}
          hint="Out of retries. These will not move without a person."
        />
        <Stat
          label="Retrying"
          value={failing.length}
          tone={failing.length ? "warn" : "ok"}
          hint="Failed at least once and will try again on their own."
        />
        <Stat label="Total recorded" value={all.length} tone="ok" hint="Across recent history." />
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setOnlyProblems((v) => !v)}>
          {onlyProblems ? "Show every fetch" : "Show only problems"}
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={onlyProblems ? "No lead capture has failed" : "No lead capture recorded yet"}
          description={
            onlyProblems
              ? "Every lead form submission the provider sent has been turned into a customer record."
              : "Nothing has arrived from a lead form yet. Register a Page and subscribe it in your Meta app."
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{rows.length} fetch attempt(s)</CardTitle>
            <p className="text-xs text-muted-foreground">
              A dead job is a lead that was submitted and never filed. Fix the cause — usually a
              missing routing rule or an expired token — then re-queue it.
            </p>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[job.status] ?? "outline"}>{job.status}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {job.attempts} of {job.maxAttempts}
                    </TableCell>
                    <TableCell>
                      <p className="max-w-md text-xs text-muted-foreground">
                        {job.lastError ?? "No error recorded."}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {when(job.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {canRetry(job) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={retry.isPending}
                          onClick={() =>
                            retry.mutate(job.id, {
                              onSuccess: (r: { requeued?: boolean; message?: string }) =>
                                r?.requeued
                                  ? toast.success("Re-queued.")
                                  : toast.error(r?.message ?? "It could not be re-queued."),
                              onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
                            })
                          }
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Re-queue
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {job.status === "succeeded" ? "Done" : "Will retry itself"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Only a job that has given up is worth a button. The rest move on their own. */
function canRetry(job: DurableJob): boolean {
  return job.status === "dead" || job.status === "failed";
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "bad";
  hint: string;
}) {
  const border =
    tone === "bad" ? "border-destructive" : tone === "warn" ? "border-warning" : "border-border";
  return (
    <Card className={border}>
      <CardContent className="space-y-1 pt-6">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {tone === "bad" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : null}
          {label}
        </div>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
