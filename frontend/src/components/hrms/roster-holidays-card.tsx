"use client";

import { PartyPopper } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { dayLabel } from "@/lib/queries/hrms-roster";

/**
 * Branch holidays, read-only, for both audiences.
 *
 * Read-only deliberately: holidays are ADDED under Shifts & Schedule, and a
 * second editor for them would be a second place to look when one of them is
 * wrong. This is the roster's view of them — the days the grid shades and the
 * days an employee is told the branch is shut.
 */
export function RosterHolidaysCard({
  holidays,
  caption,
  emptyText,
}: {
  holidays: { date: string; label: string | null }[];
  caption: string;
  emptyText: string;
}) {
  // One row per date: a person on two branches would otherwise see the same
  // holiday twice, once per branch row.
  const byDate = new Map<string, string | null>();
  for (const h of holidays) if (!byDate.has(h.date)) byDate.set(h.date, h.label);
  const rows = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-base">
          <PartyPopper className="size-4" /> Branch holidays
        </CardTitle>
        <CardDescription>{caption}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map(([date, label]) => (
              <li
                key={date}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <span className="num text-sm font-medium">{dayLabel(date)}</span>
                <span className="text-xs text-muted-foreground">{label ?? "Holiday"}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
