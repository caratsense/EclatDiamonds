"use client";

import { AlertTriangle, CheckCircle2, Flag, Users } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { type LateFlag } from "@/lib/mock/hrms";
import { StatTiles } from "@/components/hrms/stat-tiles";

/** Turn a 'YYYY-MM' month key into e.g. "July 2026". */
function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

interface LateFlagsTabProps {
  rows: LateFlag[];
  /** 'YYYY-MM' — the month these flags are rolled up for. */
  month: string;
}

export function LateFlagsTab({ rows, month }: LateFlagsTabProps) {
  const flagged = rows.filter((r) => r.flagged).length;
  const clear = rows.filter((r) => r.lateCount === 0).length;
  // Show the worst offenders first.
  const ordered = [...rows].sort((a, b) => b.lateCount - a.lateCount);

  return (
    <div className="space-y-4">
      <StatTiles
        tiles={[
          { label: "Staff tracked", value: String(rows.length), icon: Users },
          {
            label: "Flagged (3× late)",
            value: String(flagged),
            hint: "review required",
            icon: Flag,
          },
          { label: "Clear this month", value: String(clear), icon: CheckCircle2 },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-muted-foreground" />
            Late flags — {formatMonth(month)}
          </CardTitle>
          <CardDescription>
            Each check-in later than the staffer&apos;s shift start + buffer
            counts as one late. 3× in a month raises a flag.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff</TableHead>
                <TableHead className="text-right">Lates this month</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No late check-ins recorded for this month.
                  </TableCell>
                </TableRow>
              ) : null}
              {ordered.map((r) => (
                <TableRow
                  key={r.staffId}
                  className={cn(
                    r.flagged &&
                      "bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]",
                  )}
                >
                  <TableCell className="font-medium">{r.staffName}</TableCell>
                  <TableCell className="num text-right">{r.lateCount}</TableCell>
                  <TableCell className="text-right">
                    {r.flagged ? (
                      <Badge variant="warning" className="gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        3× late — flag
                      </Badge>
                    ) : (
                      <Badge variant="secondary">On track</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Salary / half-day automation is deferred — this is a flag only. No
            pay is cut automatically; the flag is a prompt for the manager to
            review.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
