"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/utils";
import { WEEK_DAYS } from "@/lib/mock/hrms";
import { useAttendanceRules, useConfirmAttendanceRules } from "@/lib/queries/hrms";

/**
 * Locations where automatic absence is off. An unconfigured location looks
 * exactly like a configured one (no weekly off and no holidays are valid
 * settings), so until head office confirms the rules, a day nobody punched
 * stays "Not marked" and a manager marks it by hand.
 */
export function AttendanceRulesBanner() {
  const { data } = useAttendanceRules();
  const off = (data ?? []).filter((r) => !r.automaticAbsence);
  if (!off.length) return null;
  return (
    /*
     * The count, and a way to act on it. Nothing else.
     *
     * This used to print the number of branches, then every branch by NAME
     * inline, then three sentences explaining the consequence and the remedy —
     * on a full-width amber panel above the page. At twelve branches that was a
     * wall of red text before any content; the list also grows with the
     * business, so it gets worse as the client succeeds.
     *
     * The names belong on the screen that fixes them, which the link goes to.
     * The full list stays reachable on hover for anyone who wants it here.
     */
    <div
      role="status"
      className="mb-4 flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1" title={off.map((r) => r.name).join(", ")}>
        Automatic absence is off at{" "}
        <span className="font-medium">
          {off.length === 1 ? off[0].name : `${off.length} branches`}
        </span>
        <span className="text-muted-foreground"> — mark those days by hand until they are set up.</span>
      </p>
      <Link
        href="/hrms/roster"
        className="shrink-0 font-medium text-warning underline-offset-4 hover:underline"
      >
        Set up
      </Link>
    </div>
  );
}

/** One location's rules, and (head office) the confirmation that turns automatic absence on. */
export function AttendanceRulesCard({ storeId, canConfirm }: { storeId: string; canConfirm: boolean }) {
  const { data } = useAttendanceRules();
  const confirm = useConfirmAttendanceRules();
  const [through, setThrough] = useState("");
  const r = data?.find((x) => x.storeId === storeId);
  if (!r) return null;

  function save(value: string | null) {
    confirm.mutate(
      { storeId, through: value },
      {
        onSuccess: () => toast.success(value ? `Confirmed through ${value}` : "Confirmation withdrawn"),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not save the confirmation.")),
      },
    );
  }

  const rows: [string, string][] = [
    ["Weekly off", r.weekOffDay == null ? "not set" : WEEK_DAYS[r.weekOffDay]],
    ["Staff with their own off day", String(r.staffWeekOffs)],
    ["Holidays", r.holidays ? `${r.holidays}, last on ${r.lastHoliday}` : "none entered"],
    [
      "Shifts",
      r.shifts.length
        ? r.shifts
            .map((s) => `${s.name} ${s.startTime}–${s.endTime}${s.graceMins == null ? " (flexible)" : `, ${s.graceMins} min grace`}`)
            .join("; ")
        : "none",
    ],
    ["Geofence", r.geofence === "set" ? "set" : "unverified — no office coordinates yet"],
  ];

  return (
    <Card className={r.automaticAbsence ? undefined : "border-warning/40"}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {r.automaticAbsence ? (
            <ShieldCheck className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          Automatic absence: {r.automaticAbsence ? "on" : "off"}
          {r.attendanceOnly ? <Badge variant="secondary">Attendance only</Badge> : null}
        </CardTitle>
        <CardDescription>
          {r.automaticAbsence
            ? `A day nobody punched is marked absent at the nightly close. Rules confirmed through ${r.confirmedThrough}.`
            : `A day nobody punched stays "Not marked": ${r.gaps.join("; ")}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {canConfirm ? (
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            <div className="space-y-1">
              <Label htmlFor={`rules-through-${storeId}`}>All of the above is complete through</Label>
              <Input
                id={`rules-through-${storeId}`}
                type="date"
                value={through}
                onChange={(e) => setThrough(e.target.value)}
                className="w-44"
              />
            </div>
            <Button size="sm" disabled={!through || confirm.isPending} onClick={() => save(through)}>
              Confirm
            </Button>
            {r.confirmedThrough ? (
              <Button size="sm" variant="ghost" disabled={confirm.isPending} onClick={() => save(null)}>
                Withdraw
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
