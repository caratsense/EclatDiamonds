"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarOff, FileText, Play, Receipt } from "lucide-react";
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
  currentPeriodKey,
  useGeneratePayslips,
  useIssuePayslip,
  usePayslip,
  usePayslips,
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

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}
