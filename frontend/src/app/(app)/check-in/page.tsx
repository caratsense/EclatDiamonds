"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  LogIn,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { homeForRole } from "@/lib/navigation";
import { markAttendanceHandled } from "@/lib/attendance-gate";
import { useSession } from "@/store/use-session";
import type { SelfAttendance } from "@/lib/mock/hrms";
import { useCheckIn, useMyAttendance } from "@/lib/queries/hrms";

/** HH:mm from an ISO instant, or an em-dash. */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Wednesday, 8 July" for today's header. */
function todayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Best-effort browser geolocation. Resolves the coords, or null when the API is
 * unsupported / permission is denied / the fix times out. The caller is lenient:
 * a null just means the punch records without geo-verification (backend allows it).
 * Mirrors the pattern in geo-punch-card.tsx.
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

/** The range chip for a landed check-in. */
function RangeChip({ record }: { record: SelfAttendance }) {
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
      Outside range
      {record.checkInDistanceM != null ? ` · ${record.checkInDistanceM} m` : ""}
    </Badge>
  );
}

/**
 * Attendance-first check-in — the salesperson's landing screen after sign-in.
 * Mobile-first (large tap targets, works at 375px). Reuses the geo-punch flow
 * (useCheckIn / useMyAttendance) rather than rebuilding it. Once the day is
 * handled (checked in or skipped) the gate won't bring them back here.
 */
export default function CheckInPage() {
  const router = useRouter();
  const { user, role, currentStore } = useSession();
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isLoading, isError, refetch } = useMyAttendance(month);
  const checkIn = useCheckIn();

  // Immediate result of a fresh punch (before the refetch lands).
  const [lastPunch, setLastPunch] = useState<SelfAttendance | null>(null);
  // True when the fresh check-in couldn't capture a location.
  const [geoMissed, setGeoMissed] = useState(false);

  const firstName = user.name.split(" ")[0] || user.name;
  const home = homeForRole(role);
  const today = lastPunch ?? data?.today ?? null;
  const checkedIn = !!today?.checkInAt;

  // Already checked in when the page loaded (not a fresh punch): mark handled
  // and gently auto-advance after ~1s. Fresh punches schedule their own
  // redirect in onSuccess, so this only covers the pre-existing case.
  useEffect(() => {
    if (lastPunch || !data?.today?.checkInAt) return;
    markAttendanceHandled();
    const t = setTimeout(() => router.replace(home), 1000);
    return () => clearTimeout(t);
  }, [lastPunch, data, home, router]);

  /** Mark the day handled + leave to the salesperson's home. */
  function goHome() {
    markAttendanceHandled();
    router.replace(home);
  }

  function skip() {
    markAttendanceHandled();
    router.replace(home);
  }

  async function handleMark() {
    const pos = await getPosition();
    const captured = pos != null;
    setGeoMissed(!captured);
    checkIn.mutate(
      { lat: pos?.lat ?? 0, lng: pos?.lng ?? 0 },
      {
        onSuccess: (row) => {
          setLastPunch(row);
          markAttendanceHandled();
          toast.success("Attendance marked", {
            description: !captured
              ? "Location unavailable — recorded without GPS."
              : row.withinFence
                ? "Within store range."
                : `Outside store range${
                    row.checkInDistanceM != null
                      ? ` · ${row.checkInDistanceM} m`
                      : ""
                  }.`,
          });
          // Auto-advance shortly after the confirmation shows.
          setTimeout(() => {
            router.replace(home);
          }, 1500);
        },
        onError: () =>
          toast.error("Could not mark attendance. Please try again."),
      },
    );
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-8">
      <Card className="facet-top overflow-hidden">
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl">Good day, {firstName}</CardTitle>
          <CardDescription>
            {todayLabel()}
            <span className="mt-1 flex items-center justify-center gap-1.5 text-sm font-medium text-foreground">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {currentStore.name}
            </span>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
            </div>
          ) : isError ? (
            <div className="rounded-xl border bg-muted/30 p-5 text-center">
              <p className="text-sm font-medium">
                Couldn&apos;t load your attendance.
              </p>
              <Button
                variant="outline"
                size="lg"
                className="mt-4 w-full"
                onClick={() => refetch()}
              >
                Retry
              </Button>
              <button
                type="button"
                onClick={skip}
                className="mt-3 text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Skip for now
              </button>
            </div>
          ) : checkedIn ? (
            /* ── Already / just checked in ─────────────────────────── */
            <div className="space-y-5">
              <div className="rounded-xl border bg-card p-5 text-center">
                <CheckCircle2 className="mx-auto h-9 w-9 text-success" />
                <p className="mt-3 text-sm text-muted-foreground">
                  You&apos;re checked in for today
                </p>
                <p className="num mt-1 text-3xl font-semibold">
                  {formatTime(today!.checkInAt)}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {geoMissed ? (
                    <Badge variant="warning" className="gap-1">
                      <MapPin className="h-3 w-3" />
                      Location not captured
                    </Badge>
                  ) : (
                    <RangeChip record={today!} />
                  )}
                  {today!.isLate ? (
                    <Badge variant="warning" className="gap-1">
                      <Clock className="h-3 w-3" />
                      {today!.lateMinutes
                        ? `Late ${today!.lateMinutes}m`
                        : "Late"}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                onClick={goHome}
              >
                Continue to app
              </Button>
            </div>
          ) : (
            /* ── Not checked in yet ────────────────────────────────── */
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                You haven&apos;t marked attendance today. Your location is
                captured to verify you&apos;re at the store.
              </p>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                disabled={checkIn.isPending}
                onClick={handleMark}
              >
                {checkIn.isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Marking…
                  </>
                ) : (
                  <>
                    <LogIn className="h-5 w-5" />
                    Mark attendance
                  </>
                )}
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  onClick={skip}
                  className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Skip for now
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
