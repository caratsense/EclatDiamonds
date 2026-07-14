"use client";

import { CheckCircle2, AlertTriangle, MapPin, Clock, Users } from "lucide-react";

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
import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import type { AttendanceRecord } from "@/lib/mock/hrms";
import type { Geofence } from "@/lib/queries/hrms";
import { StatTiles } from "@/components/hrms/stat-tiles";

/**
 * Status badge that surfaces lateness against the staffer's OWN shift.
 * `isLate` / `lateMinutes` are derived server-side against the assigned
 * shift's start + buffer — a 2nd-batch person is never "late" for the
 * morning shift's start. Falls back to `status` for older records.
 */
function StatusBadge({ record }: { record: AttendanceRecord }) {
  if (record.status === "on_leave") {
    return <Badge variant="secondary">On leave</Badge>;
  }
  if (record.status === "absent") {
    return <Badge variant="destructive">Absent</Badge>;
  }
  const late = record.isLate ?? record.status === "late";
  if (late) {
    return (
      <Badge variant="warning" className="gap-1">
        <Clock className="h-3 w-3" />
        {record.lateMinutes ? `Late ${record.lateMinutes}m` : "Late"}
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      On time
    </Badge>
  );
}

function FenceBadge({ within }: { within: boolean }) {
  return within ? (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      Within geofence
    </Badge>
  ) : (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      Outside fence
    </Badge>
  );
}

interface AttendanceTabProps {
  records: AttendanceRecord[];
  /**
   * The active store's resolved geofence (GET /hrms/geofence); undefined for
   * the aggregate view. `hasCoords === false` means the store has no
   * coordinates set — check-ins are recorded but not distance-verified.
   */
  fence?: Geofence;
}

export function AttendanceTab({ records, fence }: AttendanceTabProps) {
  const checkedIn = records.filter((r) => r.checkIn);
  const present = records.filter((r) => r.status === "present").length;
  const late = records.filter((r) => r.status === "late").length;
  const breaches = checkedIn.filter((r) => !r.withinFence).length;
  const onLeave = records.filter((r) => r.status === "on_leave").length;

  const hasCoords =
    !!fence && fence.hasCoords && fence.latitude != null && fence.longitude != null;

  return (
    <div className="space-y-4">
      <StatTiles
        tiles={[
          { label: "Checked in", value: String(checkedIn.length), icon: Clock },
          { label: "Present", value: String(present), hint: `${late} late`, icon: Users },
          {
            label: "Geofence breaches",
            value: String(breaches),
            hint: "pings outside store radius",
            icon: AlertTriangle,
          },
          { label: "On leave", value: String(onLeave), icon: Users },
        ]}
      />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              Store geofence
            </CardTitle>
            <CardDescription>
              {fence
                ? `Check-ins are verified against ${fence.storeName}.`
                : "Select a single store to verify check-ins against its geofence."}
            </CardDescription>
          </div>
          {hasCoords ? (
            <Badge variant="outline" className="shrink-0">
              radius <span className="num">{fence!.geofenceRadiusM}</span> m
            </Badge>
          ) : null}
        </CardHeader>
        {fence ? (
          hasCoords ? (
            <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Centre latitude</p>
                <p className="num font-medium">{fence.latitude!.toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Centre longitude</p>
                <p className="num font-medium">{fence.longitude!.toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Allowed radius</p>
                <p className="font-medium">
                  <span className="num">{fence.geofenceRadiusM}</span> metres
                </p>
              </div>
            </CardContent>
          ) : (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                This store has no geofence coordinates set. Check-ins are still
                recorded, but they aren&apos;t distance-verified until the store
                centre is configured.
              </p>
            </CardContent>
          )
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s attendance</CardTitle>
          <CardDescription>
            Geo-tagged check-in/out with distance from the store centre.
            Lateness is measured against each staffer&apos;s own shift start +
            buffer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead className="text-right">Distance</TableHead>
                <TableHead>Geo verify</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No attendance marked yet — mark the first staff member in.
                  </TableCell>
                </TableRow>
              ) : null}
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-xs">
                          {r.initials}
                        </AvatarFallback>
                      </Avatar>
                      <div className="leading-tight">
                        <p className="font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">{r.role}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.shift}</TableCell>
                  <TableCell className="num">{r.checkIn ?? "—"}</TableCell>
                  <TableCell className="num">{r.checkOut ?? "—"}</TableCell>
                  <TableCell className="num text-right">
                    {r.checkIn ? `${r.distanceM} m` : "—"}
                  </TableCell>
                  <TableCell>
                    {r.checkIn ? <FenceBadge within={r.withinFence} /> : (
                      <span className="text-xs text-muted-foreground">no ping</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge record={r} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
