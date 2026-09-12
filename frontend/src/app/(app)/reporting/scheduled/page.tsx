"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarClock,
  Download,
  Mail,
  MailWarning,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  REPORT_COLUMNS,
  describeDelivery,
  useCreateScheduledReport,
  useDeleteScheduledReport,
  useDownloadScheduledReport,
  useRunScheduledReport,
  useScheduledReportRuns,
  useScheduledReports,
  useUpdateScheduledReport,
  type ScheduledReport,
} from "@/lib/queries/scheduled-reports";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const DELIVERY_TONE: Record<string, PillTone> = {
  sent: "good",
  dry_run: "wait",
  no_recipients: "wait",
  failed: "bad",
};

/**
 * Reports that send themselves.
 *
 * The screen's job is to make two things impossible to misread: what period a
 * file covers, and whether it actually reached anybody. A row that said "sent"
 * when SMTP is not configured would be discovered only by the person wondering
 * why their inbox is empty, so the delivery state is shown in words on every
 * run.
 */
export default function ScheduledReportsPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const canManage = role === "store_manager" || role === "area_manager" || role === "head_office";

  const reports = useScheduledReports();
  const create = useCreateScheduledReport();
  const update = useUpdateScheduledReport();
  const remove = useDeleteScheduledReport();
  const run = useRunScheduledReport();
  const download = useDownloadScheduledReport();

  const [showNew, setShowNew] = useState(false);
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const runs = useScheduledReportRuns(openRuns);

  const [form, setForm] = useState({
    name: "",
    cadence: "monthly" as "monthly" | "weekly",
    sendHour: "7",
    storeId: "",
    recipients: "",
    columns: [] as string[],
  });

  const toggleColumn = (key: string) =>
    setForm((f) => ({
      ...f,
      columns: f.columns.includes(key)
        ? f.columns.filter((c) => c !== key)
        : [...f.columns, key],
    }));

  const onCreate = () => {
    create.mutate(
      {
        name: form.name.trim(),
        cadence: form.cadence,
        sendHour: Number(form.sendHour) || 7,
        storeId: form.storeId || null,
        // Empty means every column, which is what the server does with it.
        columns: form.columns,
        recipients: form.recipients
          .split(/[,;\s]+/)
          .map((r) => r.trim())
          .filter(Boolean),
      },
      {
        onSuccess: (r) => {
          toast.success(`“${r.name}” will send ${r.cadence === "weekly" ? "every Monday" : "on the 1st"}`);
          setShowNew(false);
          setForm({
            name: "",
            cadence: "monthly",
            sendHour: "7",
            storeId: "",
            recipients: "",
            columns: [],
          });
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not create that report.")),
      },
    );
  };

  const onRun = (report: ScheduledReport) => {
    run.mutate(report.id, {
      onSuccess: (res) =>
        res.alreadyDelivered
          ? toast.info(`${res.periodKey} has already been sent`, {
              description: "Sending it again would put a second copy in every inbox.",
            })
          : toast.success(`${report.name} — ${res.periodKey}`, {
              description: `${res.rows} row(s). ${describeDelivery({
                emailStatus: res.emailStatus,
                emailDetail: null,
              })}.`,
            }),
      onError: (e) => toast.error(apiErrorMessage(e, "Could not send it.")),
    });
  };

  const onDownload = (report: ScheduledReport) => {
    download.mutate(report.id, {
      onSuccess: (res) => toast.success(`${res.filename} — ${res.rows} row(s)`),
      onError: (e) => toast.error(apiErrorMessage(e, "Could not build that file.")),
    });
  };

  const items = reports.data ?? [];

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/reporting"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Reporting
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <CalendarClock className="size-5" /> Scheduled reports
            </h1>
            <p className="text-sm text-muted-foreground">
              A lead spreadsheet that arrives by email on its own. Monthly reports cover the month
              that ended; weekly ones cover the week that ended.
            </p>
          </div>
          {canManage ? (
            <Button onClick={() => setShowNew((v) => !v)}>
              <Plus className="size-4" /> New report
            </Button>
          ) : null}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {showNew && canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New scheduled report</CardTitle>
            <CardDescription>
              Choose the columns you want. The file has those, in that order — not every column
              with an instruction to ignore most of them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="rep-name">Name</Label>
                <Input
                  id="rep-name"
                  placeholder="Month-end leads"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rep-cadence">How often</Label>
                <select
                  id="rep-cadence"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={form.cadence}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, cadence: e.target.value as "monthly" | "weekly" }))
                  }
                >
                  <option value="monthly">Monthly — on the 1st</option>
                  <option value="weekly">Weekly — on Monday</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rep-hour">Hour at the branch</Label>
                <Input
                  id="rep-hour"
                  inputMode="numeric"
                  value={form.sendHour}
                  onChange={(e) => setForm((f) => ({ ...f, sendHour: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rep-store">Branch</Label>
                <select
                  id="rep-store"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={form.storeId}
                  onChange={(e) => setForm((f) => ({ ...f, storeId: e.target.value }))}
                >
                  <option value="">Every branch</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rep-to">Send to</Label>
              <Input
                id="rep-to"
                placeholder="owner@example.com, manager@example.com"
                value={form.recipients}
                onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to produce the file without emailing it.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Columns</Label>
              <div className="flex flex-wrap gap-1.5">
                {REPORT_COLUMNS.map((c) => {
                  const on = form.columns.includes(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => toggleColumn(c.key)}
                      className={
                        on
                          ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium"
                          : "rounded-full border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                      }
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {form.columns.length === 0
                  ? "None chosen — the file will carry every column."
                  : `${form.columns.length} column(s), in the order you picked them.`}
              </p>
            </div>

            <div className="flex gap-2">
              <Button onClick={onCreate} disabled={create.isPending || form.name.trim().length < 2}>
                Create
              </Button>
              <Button variant="ghost" onClick={() => setShowNew(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {reports.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No scheduled reports"
          description="Nothing is being sent automatically. A month-end lead report is the usual first one."
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Report</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Goes to</TableHead>
                <TableHead>Last sent</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.id} className={r.isActive ? undefined : "opacity-60"}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => setOpenRuns(openRuns === r.id ? null : r.id)}
                    >
                      {r.name}
                    </button>
                    <div className="text-xs text-muted-foreground">
                      {r.columns.length === 0
                        ? "All columns"
                        : `${r.columns.length} column(s)`}
                      {r.isActive ? "" : " · paused"}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.cadence === "weekly" ? "Mondays" : "1st of the month"} ·{" "}
                    <span className="num">{String(r.sendHour).padStart(2, "0")}:00</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.storeName ?? "Every branch"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.recipients.length === 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <MailWarning className="size-3.5" /> Nobody
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Mail className="size-3.5" /> {r.recipients.length}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.lastRun ? (
                      <div className="space-y-1">
                        <div className="num text-sm">{r.lastRun.periodKey}</div>
                        <StatusPill
                          tone={DELIVERY_TONE[r.lastRun.emailStatus] ?? "mute"}
                          title={describeDelivery(r.lastRun)}
                        >
                          {r.lastRun.rows} row{r.lastRun.rows === 1 ? "" : "s"}
                        </StatusPill>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Download the last completed period"
                        onClick={() => onDownload(r)}
                        disabled={download.isPending}
                      >
                        <Download className="size-4" />
                      </Button>
                      {canManage ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Send the last completed period now"
                            onClick={() => onRun(r)}
                            disabled={run.isPending}
                          >
                            <Send className="size-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              update.mutate(
                                { id: r.id, isActive: !r.isActive },
                                {
                                  onError: (e) =>
                                    toast.error(apiErrorMessage(e, "Could not change that.")),
                                },
                              )
                            }
                          >
                            {r.isActive ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Delete this report and its history"
                            onClick={() =>
                              remove.mutate(r.id, {
                                onSuccess: () => toast.success(`Deleted “${r.name}”`),
                                onError: (e) =>
                                  toast.error(apiErrorMessage(e, "Could not delete it.")),
                              })
                            }
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {openRuns ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">History</CardTitle>
            <CardDescription>
              One row per period. A period is only ever delivered once, however many times it is
              asked for.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {runs.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (runs.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">It has not run yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runs.data ?? []).map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="num font-medium">{run.periodKey}</TableCell>
                      <TableCell className="num text-right">{run.rows}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill tone={DELIVERY_TONE[run.emailStatus] ?? "mute"}>
                            {run.emailStatus.replace("_", " ")}
                          </StatusPill>
                          <span className="text-xs text-muted-foreground">
                            {describeDelivery(run)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="num text-muted-foreground">
                        {new Date(run.createdAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
