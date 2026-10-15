"use client";

import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StateBadge } from "@/components/hrms/today-tab";
import {
  formatDayLabel,
  formatWorkedMins,
} from "@/components/hrms/attendance-correction-policy";
import type { SelfAttendanceDay } from "@/lib/queries/hrms";

/**
 * My month as a list — the same days the calendar paints, with the figures a
 * grid cell has no room for: the shift each day was judged against, the hours
 * recorded, and whether the punch landed inside the store's geofence.
 *
 * Narrow screens keep date, status, punches and the correction pencil; the
 * supporting columns fold away rather than forcing a sideways scroll on a phone.
 */
export function MyDayList({
  records,
  onRequestFix,
}: {
  records: SelfAttendanceDay[];
  onRequestFix: (date: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="hidden sm:table-cell">Shift</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead>
            <TableHead className="text-right">Worked</TableHead>
            <TableHead className="hidden text-right md:table-cell">Geo</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Request correction</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-xs sm:text-sm">
                {formatDayLabel(r.date)}
              </TableCell>
              <TableCell className="num hidden whitespace-nowrap text-xs sm:table-cell">
                {r.shiftName
                  ? `${r.shiftName}${
                      r.shiftStart && r.shiftEnd
                        ? ` · ${r.shiftStart}–${r.shiftEnd}`
                        : ""
                    }`
                  : "—"}
              </TableCell>
              <TableCell>
                <StateBadge state={r.status} isLate={r.isLate} />
              </TableCell>
              <TableCell className="num text-right">
                {r.checkInLocal || "—"}
              </TableCell>
              <TableCell className="num text-right">
                {r.checkOutLocal || "—"}
              </TableCell>
              <TableCell className="num whitespace-nowrap text-right">
                {formatWorkedMins(r.workedMins)}
                {r.overtimeMins ? (
                  <span className="ml-1 text-xs text-warning">
                    +{formatWorkedMins(r.overtimeMins)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="hidden text-right md:table-cell">
                {r.checkInAt ? (
                  r.withinFence ? (
                    <Badge variant="success">Within</Badge>
                  ) : (
                    <Badge variant="warning">
                      {r.checkInDistanceM != null
                        ? `${r.checkInDistanceM} m`
                        : "Outside"}
                    </Badge>
                  )
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={`Request a correction for ${formatDayLabel(r.date)}`}
                  title="Request correction"
                  onClick={() => onRequestFix(r.date)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
