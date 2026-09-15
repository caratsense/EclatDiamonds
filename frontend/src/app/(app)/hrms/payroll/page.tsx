"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarOff, FileText, History, Play, Receipt, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DAY_KIND,
  DAY_NAMES,
  type PayrollRun,
  currentPeriodKey,
  useGeneratePayslips,
  useIssuePayslip,
  usePayrollRuns,
  usePayslip,
  usePayslips,
  useRerunPayroll,
  useSetWeekOffs,
  useWeekOffRoster,
} from "@/lib/queries/payroll";
import { formatINR } from "@/lib/format";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The roster, and what a month of it comes to.
 *
 * Two things the screen is careful to say out loud. A weekly off set for one
 * person REPLACES the branch's day rather than adding to it — shown as
 * "effective" on every row, so nobody has to infer it. And a payslip's note
 * ("before tax and statutory deductions") is printed on the slip itself, because
 * a figure labelled net pay with no tax in it will otherwise be read as
 * take-home by the one person who cannot afford to be wrong about it.
 */
export default function PayrollPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const canManage = role === "store_manager" || role === "area_manager" || role === "head_office";

  const [storeId, setStoreId] = useState("");
  const [period, setPeriod] = useState(currentPeriodKey());
  const [openSlip, setOpenSlip] = useState<string | null>(null);

  const roster = useWeekOffRoster(storeId || undefined);
  const setWeekOffs = useSetWeekOffs();
  const slips = usePayslips({ periodKey: period, storeId: storeId || undefined });
  const slip = usePayslip(openSlip);
  const generate = useGeneratePayslips();
  const issue = useIssuePayslip();
  const runs = usePayrollRuns({ periodKey: period, storeId: storeId || undefined }, canManage);
  const rerun = useRerunPayroll();

  const onRerun = (run: PayrollRun) => {
    rerun.mutate(
      { storeId: run.storeId, periodKey: run.periodKey },
      {
        onSuccess: (res) =>
          res.status === "failed"
            ? toast.error("The run did not finish.", { description: res.error ?? undefined })
            : toast.success(`${res.generated} draft(s) for ${res.periodKey}`, {
                description: res.differences
                  ? `${res.differences} issued slip(s) no longer match the register.`
                  : undefined,
              }),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not run it.")),
      },
    );
  };

  const toggleDay = (userId: string, current: number[], day: number) => {
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort();
    setWeekOffs.mutate(
      { userId, storeId: storeId || undefined, days: next },
      {
        onError: (e) => toast.error(apiErrorMessage(e, "Could not change that roster.")),
      },
    );
  };

  const onGenerate = () => {
    generate.mutate(
      { storeId: storeId || undefined, periodKey: period },
      {
        onSuccess: (res) => {
          if ("generated" in res) {
            toast.success(`${res.generated} payslip(s) for ${res.periodKey}`, {
              description: res.skipped.length
                ? `Skipped: ${res.skipped.map((s) => s.name).join(", ")}`
                : undefined,
            });
          }
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not generate them.")),
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/hrms"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Attendance
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Receipt className="size-5" /> Roster and pay
        </h1>
        <p className="text-sm text-muted-foreground">
          Each person&rsquo;s own weekly off, and a payslip counted from the attendance register.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          <option value="">Every branch</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <Label htmlFor="period" className="text-sm text-muted-foreground">
            Month
          </Label>
          <Input
            id="period"
            className="w-32"
            placeholder="2026-09"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </div>
        {canManage ? (
          <Button onClick={onGenerate} disabled={generate.isPending}>
            <Play className="size-4" />
            {generate.isPending ? "Generating…" : "Generate payslips"}
          </Button>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- */}
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarOff className="size-4" /> Weekly offs
            </CardTitle>
            <CardDescription>
              Tick a day to give somebody their own weekly off. Their days replace the
              branch&rsquo;s &mdash; they do not add to it. Untick everything and they follow the
              branch again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {roster.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      {DAY_NAMES.map((d) => (
                        <TableHead key={d} className="text-center">
                          {d.slice(0, 3)}
                        </TableHead>
                      ))}
                      <TableHead>Effective</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(roster.data?.staff ?? []).map((s) => (
                      <TableRow key={s.userId}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        {DAY_NAMES.map((_, day) => (
                          <TableCell key={day} className="text-center">
                            <input
                              type="checkbox"
                              aria-label={`${s.name} off on ${DAY_NAMES[day]}`}
                              checked={s.days.includes(day)}
                              onChange={() => toggleDay(s.userId, s.days, day)}
                              disabled={setWeekOffs.isPending}
                            />
                          </TableCell>
                        ))}
                        <TableCell className="text-xs text-muted-foreground">
                          {s.effectiveDays.length === 0
                            ? "None"
                            : s.effectiveDays.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ")}
                          {s.followsStore ? " (branch)" : ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="size-4" /> Payroll runs for {period}
            </CardTitle>
            <CardDescription>
              Once a branch&rsquo;s month has closed there, CaratOS drafts its payslips and tells
              the branch&rsquo;s managers and head office. It only drafts &mdash; nothing is issued
              or paid automatically. Re-run a month after late corrections or if a run failed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {runs.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (runs.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No run for this month yet. The automatic one happens after the month closes, for
                branches where somebody&rsquo;s pay is recorded.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Branch</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Drafted</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                      <TableHead className="text-right">Issued</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(runs.data ?? []).map((r) => {
                      const state = runState(r);
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">
                            {stores.find((s) => s.id === r.storeId)?.name ?? "—"}
                          </TableCell>
                          <TableCell className="num whitespace-nowrap text-xs">
                            {new Date(r.startedAt).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.trigger === "scheduler" ? "Automatic" : (r.triggeredByName ?? "—")}
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={state.tone}>{state.label}</StatusPill>
                            {r.error ? (
                              <div className="max-w-xs text-xs text-rose-600 dark:text-rose-400">
                                {r.error}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className="num text-right">{r.generated}</TableCell>
                          <TableCell
                            className="num text-right text-muted-foreground"
                            title={(r.skippedDetail ?? [])
                              .map((s) => `${s.name}: ${s.reason}`)
                              .join("\n")}
                          >
                            {r.skipped}
                          </TableCell>
                          <TableCell className="num text-right text-muted-foreground">
                            {r.issued}
                            {r.differences ? (
                              <span className="text-rose-600 dark:text-rose-400">
                                {" "}
                                ({r.differences} changed)
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onRerun(r)}
                              disabled={rerun.isPending}
                            >
                              <RotateCw className="size-3.5" /> Re-run
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {slips.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (slips.data ?? []).length === 0 ? (
        <EmptyState
          icon={FileText}
          title={`No payslips for ${period}`}
          description={
            canManage
              ? "Record what people are paid, then generate the month."
              : "Nothing has been issued to you for this month."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Present</TableHead>
                <TableHead className="text-right">Off / holiday</TableHead>
                <TableHead className="text-right">Unpaid</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="text-right">Net pay</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(slips.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => setOpenSlip(openSlip === s.id ? null : s.id)}
                    >
                      {s.staffName}
                    </button>
                    <div className="text-xs text-muted-foreground">
                      {s.basis === "daily" ? "Daily wage" : "Monthly salary"} ·{" "}
                      {formatINR(s.perDayRate)}/day
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">{s.presentDays}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {s.weeklyOffDays + s.holidayDays}
                  </TableCell>
                  <TableCell
                    className={
                      s.unpaidDays > 0
                        ? "num text-right text-rose-600 dark:text-rose-400"
                        : "num text-right"
                    }
                  >
                    {s.unpaidDays}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {s.overtimeMins > 0
                      ? `${Math.round((s.overtimeMins / 60) * 10) / 10}h${
                          s.overtimeAmount === 0 ? " (unpaid)" : ""
                        }`
                      : "—"}
                  </TableCell>
                  <TableCell className="num text-right font-semibold">
                    {formatINR(s.netPay)}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={s.status === "issued" ? "good" : "wait"}>
                      {s.status === "issued" ? "Issued" : "Draft"}
                    </StatusPill>
                    {s.difference ? (
                      <StatusPill tone="bad" className="ml-1">
                        Register changed
                      </StatusPill>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && s.status === "draft" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          issue.mutate(s.id, {
                            onSuccess: () =>
                              toast.success(`${s.staffName}'s ${s.periodKey} slip issued`, {
                                description: "It will not change from here.",
                              }),
                            onError: (e) =>
                              toast.error(apiErrorMessage(e, "Could not issue it.")),
                          })
                        }
                      >
                        Issue
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {openSlip && slip.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {slip.data.staffName} — {slip.data.periodKey}
            </CardTitle>
            <CardDescription>{slip.data.note}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Figure label={slip.data.basis === "daily" ? "Day rate" : "Monthly"} value={formatINR(slip.data.amount)} />
              <Figure label="Earned" value={formatINR(slip.data.earnedAmount)} />
              <Figure label="Deducted" value={formatINR(slip.data.deductionAmount)} />
              <Figure label="Overtime" value={formatINR(slip.data.overtimeAmount)} />
            </div>

            {slip.data.difference ? (
              <div className="space-y-2 rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-sm">
                <div className="font-medium">The register has changed since this slip was issued</div>
                <p className="text-xs text-muted-foreground">
                  The figures above are what was issued and stay as they are. Settle the difference
                  separately.
                  {slip.data.differenceDetectedAt
                    ? ` Noticed ${new Date(slip.data.differenceDetectedAt).toLocaleString()}.`
                    : ""}
                </p>
                <ul className="space-y-1 text-xs">
                  {slip.data.difference.days.map((d) => (
                    <li key={d.date} className="num">
                      {d.date}: {d.was ? DAY_KIND[d.was.kind].label : "—"} &rarr;{" "}
                      {DAY_KIND[d.now.kind].label}
                    </li>
                  ))}
                  <li className="num">
                    Present days: {slip.data.difference.presentDays.was} &rarr;{" "}
                    {slip.data.difference.presentDays.now}
                  </li>
                  {slip.data.difference.overtimeMins.was !== slip.data.difference.overtimeMins.now ? (
                    <li className="num">
                      Overtime minutes: {slip.data.difference.overtimeMins.was} &rarr;{" "}
                      {slip.data.difference.overtimeMins.now}
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {slip.data.breakdown ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Day</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead>Paid</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slip.data.breakdown.map((d) => (
                      <TableRow key={d.date}>
                        <TableCell className="num">{d.date}</TableCell>
                        <TableCell>
                          <StatusPill tone={DAY_KIND[d.kind].tone}>
                            {DAY_KIND[d.kind].label}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="num text-right">{d.credit}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {d.paid ? "Yes" : "No"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * How a run reads. A run still "started" long after it began did not finish —
 * the process stopped part-way — and is shown as such so somebody re-runs it.
 */
function runState(r: PayrollRun): { label: string; tone: "good" | "bad" | "wait" } {
  if (r.status === "completed") return { label: "Completed", tone: "good" };
  if (r.status === "failed") return { label: "Failed", tone: "bad" };
  return Date.now() - new Date(r.startedAt).getTime() > 30 * 60_000
    ? { label: "Interrupted", tone: "bad" }
    : { label: "Running", tone: "wait" };
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}
