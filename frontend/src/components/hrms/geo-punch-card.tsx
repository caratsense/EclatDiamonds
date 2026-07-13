"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  LogIn,
  LogOut,
  MapPin,
} from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import type { SelfAttendance } from "@/lib/mock/hrms";
import {
  useCheckIn,
  useCheckOut,
  useMyAttendance,
  useShifts,
} from "@/lib/queries/hrms";

/** HH:mm from an ISO instant, or an em-dash. */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Wed 8 Jul" from a YYYY-MM-DD (parsed as local — no tz drift). */
function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Minutes → "6h 20m" / "45m". */
function formatWorked(mins: number | null): string {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Best-effort browser geolocation. Resolves the coords, or null when the API is
 * unsupported / permission is denied / the fix times out. The caller is lenient:
 * a null just means the punch records without geo-verification (backend allows it).
 */
function getPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

/** The geo outcome of the last / today's check-in. */
function GeoResult({
  record,
  missed,
}: {
  record: SelfAttendance;
  missed: boolean;
}) {
  if (missed) {
    return (
      <Badge variant="warning" className="gap-1">
        <MapPin className="h-3 w-3" />
        Location not captured
      </Badge>
    );
  }
  if (record.withinFence) {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Within range
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      Outside store range
      {record.checkInDistanceM != null ? ` — ${record.checkInDistanceM} m` : ""}
    </Badge>
  );
}

/**
 * "My Attendance" — self-service phone geo punch (Module 6, Zoho-informed).
 * Any staffer punches in/out from their own device; geolocation is captured on
 * the button press and posted with the punch. Store-scoped via the api client's
 * X-Store-Id header (the active store).
 */
export function GeoPunchCard() {
  const { user } = useSession();
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isLoading, isError, refetch } = useMyAttendance(month);
  const { data: shifts = [] } = useShifts();
  const checkIn = useCheckIn();
  const checkOut = useCheckOut();

  const [shiftId, setShiftId] = useState<string>("");
  // Immediate result of the latest punch (before the refetch lands).
  const [lastPunch, setLastPunch] = useState<SelfAttendance | null>(null);
  // True when the latest check-in couldn't capture a location.
  const [geoMissed, setGeoMissed] = useState(false);

  const today = lastPunch ?? data?.today ?? null;
  const records = data?.records ?? [];
  const punching = checkIn.isPending || checkOut.isPending;

  const checkedIn = !!today?.checkInAt;
  const checkedOut = !!today?.checkOutAt;

  async function handleCheckIn() {
    const pos = await getPosition();
    const captured = pos != null;
    setGeoMissed(!captured);
    if (!captured) {
      toast.error("Couldn't capture your location", {
        description:
          "Recording the check-in without geo-verification — a manager can regularize it.",
      });
    }
    checkIn.mutate(
      { lat: pos?.lat ?? 0, lng: pos?.lng ?? 0, shiftId: shiftId || undefined },
      {
        onSuccess: (row) => {
          setLastPunch(row);
          toast.success("Checked in", {
            description: !captured
              ? "Location not verified."
              : row.withinFence
                ? "Within store range."
                : `Outside store range${
                    row.checkInDistanceM != null
                      ? ` — ${row.checkInDistanceM} m`
                      : ""
                  }.`,
          });
        },
        onError: () => toast.error("Could not check in. Please try again."),
      },
    );
  }

  async function handleCheckOut() {
    const pos = await getPosition();
    if (!pos) {
      toast.error("Couldn't capture your location", {
        description: "Recording the check-out without geo-verification.",
      });
    }
    checkOut.mutate(
      { lat: pos?.lat ?? 0, lng: pos?.lng ?? 0 },
      {
        onSuccess: (row) => {
          setLastPunch(row);
          toast.success("Checked out", {
            description: `Worked ${formatWorked(row.workedMins)}.`,
          });
        },
        onError: () =>
          toast.error("Could not check out. You may not be checked in."),
      },
    );
  }

  return (
    <Card className="facet-top overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            My attendance
          </CardTitle>
          <CardDescription>
            Punch in and out from your phone. Your location is captured to verify
            you&apos;re at the store.
          </CardDescription>
        </div>
        <Badge variant="outline" className="shrink-0">
          {formatDayLabel(new Date().toISOString().slice(0, 10))}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Logged-in employee identity — name + id/email, like the
            EzAttendancePro dashboard header. */}
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="text-xs">{user.initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="num truncate text-xs text-muted-foreground">
              {user.email || `ID ${user.id.slice(0, 8)}`}
            </p>
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : isError ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load your attendance.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-4">
            {/* --- Not checked in yet -------------------------------- */}
            {!checkedIn ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  You haven&apos;t checked in today.
                </p>
                {shifts.length > 0 ? (
                  <div className="grid gap-1.5 sm:max-w-xs">
                    <Label htmlFor="punch-shift">Shift / batch</Label>
                    <Select value={shiftId} onValueChange={setShiftId}>
                      <SelectTrigger id="punch-shift">
                        <SelectValue placeholder="Store default shift" />
                      </SelectTrigger>
                      <SelectContent>
                        {shifts.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} · {s.startTime}–{s.endTime}
                            {s.isNightBatch ? " (night)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <Button
                  variant="gold"
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={punching}
                  onClick={handleCheckIn}
                >
                  <LogIn className="h-4 w-4" />
                  {checkIn.isPending ? "Checking in…" : "Check in"}
                </Button>
              </div>
            ) : null}

            {/* --- Checked in, not out ------------------------------- */}
            {checkedIn && !checkedOut ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground">
                      Checked in at
                    </span>
                    <span className="num text-2xl font-semibold">
                      {formatTime(today!.checkInAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <GeoResult record={today!} missed={geoMissed} />
                    {today!.isLate ? (
                      <Badge variant="warning" className="gap-1">
                        <Clock className="h-3 w-3" />
                        {today!.lateMinutes
                          ? `Late ${today!.lateMinutes}m`
                          : "Late"}
                      </Badge>
                    ) : (
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        On time
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={punching}
                  onClick={handleCheckOut}
                >
                  <LogOut className="h-4 w-4" />
                  {checkOut.isPending ? "Checking out…" : "Check out"}
                </Button>
              </div>
            ) : null}

            {/* --- Checked out --------------------------------------- */}
            {checkedIn && checkedOut ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div>
                  <p className="text-xs text-muted-foreground">In</p>
                  <p className="num text-lg font-semibold">
                    {formatTime(today!.checkInAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Out</p>
                  <p className="num text-lg font-semibold">
                    {formatTime(today!.checkOutAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Worked</p>
                  <p className="num text-lg font-semibold text-success">
                    {formatWorked(today!.workedMins)}
                  </p>
                </div>
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Day complete
                </Badge>
              </div>
            ) : null}
          </div>
        )}

        {/* --- This month's punch list ------------------------------ */}
        {!isLoading && !isError ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">This month</p>
            {records.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                No attendance recorded this month yet.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-left font-medium">In</th>
                      <th className="px-3 py-2 text-left font-medium">Out</th>
                      <th className="px-3 py-2 text-right font-medium">Worked</th>
                      <th className="px-3 py-2 text-right font-medium">Geo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="px-3 py-2">{formatDayLabel(r.date)}</td>
                        <td className="num px-3 py-2">
                          <span
                            className={cn(
                              r.isLate && "text-warning",
                            )}
                          >
                            {formatTime(r.checkInAt)}
                          </span>
                          {r.isLate ? (
                            <span className="ml-1 text-xs text-warning">late</span>
                          ) : null}
                        </td>
                        <td className="num px-3 py-2">
                          {formatTime(r.checkOutAt)}
                        </td>
                        <td className="num px-3 py-2 text-right">
                          {formatWorked(r.workedMins)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.checkInAt ? (
                            r.withinFence ? (
                              <span className="text-success">within</span>
                            ) : (
                              <span className="text-warning">
                                {r.checkInDistanceM != null
                                  ? `${r.checkInDistanceM} m`
                                  : "outside"}
                              </span>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
