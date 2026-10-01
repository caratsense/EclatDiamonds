/** Browser position captured at the moment of an attendance punch. */
export interface PunchPosition {
  lat: number;
  lng: number;
  accuracyM?: number;
}

/** The store fence contract returned by GET /hrms/geofence. */
export interface PunchFence {
  hasCoords: boolean;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
}

export type PunchLocationDecision =
  | { state: "unfenced"; distanceM: null }
  | { state: "unavailable"; distanceM: null }
  | { state: "inside"; distanceM: number }
  | { state: "imprecise"; distanceM: number }
  | { state: "outside"; distanceM: number };

export type PunchAction = "allow" | "reason" | "block";

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radiusM = 6_371_000;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
      Math.cos(toRadians(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  return radiusM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Mirrors the server's geofence decision exactly. In particular, a GPS fix
 * whose uncertainty reaches across the fence is not treated as proof that the
 * person is either inside or outside.
 */
export function evaluatePunchLocation(
  position: PunchPosition | null,
  fence: PunchFence | null | undefined,
): PunchLocationDecision {
  if (
    !fence?.hasCoords ||
    fence.latitude == null ||
    fence.longitude == null
  ) {
    return { state: "unfenced", distanceM: null };
  }
  if (!position) return { state: "unavailable", distanceM: null };

  const distance = distanceM(position, {
    lat: fence.latitude,
    lng: fence.longitude,
  });
  const accuracy = position.accuracyM;
  const imprecise =
    accuracy != null &&
    Number.isFinite(accuracy) &&
    accuracy > 0 &&
    distance <= fence.geofenceRadiusM + accuracy &&
    (accuracy > fence.geofenceRadiusM || distance > fence.geofenceRadiusM);

  const roundedDistance = Math.round(distance);
  if (imprecise) return { state: "imprecise", distanceM: roundedDistance };
  if (distance <= fence.geofenceRadiusM) {
    return { state: "inside", distanceM: roundedDistance };
  }
  return { state: "outside", distanceM: roundedDistance };
}

/**
 * A confident outside check-in is refused. A missing/imprecise fix needs a
 * written reason for either direction, while an outside check-out also needs a
 * reason so a staffer is not stranded after leaving the branch.
 */
export function punchAction(
  decision: PunchLocationDecision,
  kind: "in" | "out",
): PunchAction {
  if (decision.state === "unfenced" || decision.state === "inside") return "allow";
  if (decision.state === "outside" && kind === "in") return "block";
  return "reason";
}

/**
 * What someone is told when a check-in is refused for distance. It names the
 * branch the distance was measured from: "635 m away" on its own reads as a
 * faulty phone to someone standing in a branch, just not the one they are
 * assigned to, and gives a manager nothing to fix.
 */
export function tooFarMessage(
  branchName: string,
  distanceM: number,
  radiusM: number,
): string {
  return `You are ${distanceM} m from ${branchName}. Move within ${radiusM} m of it, or ask a manager to fix your attendance.`;
}

export type PunchScreen = "check-in" | "check-out" | "done" | "move-on";

/**
 * What the punch screen (/check-in) is for, given today's punches.
 *
 * Most people only pass through it: once they are in, it sends them on to
 * their own home and they check out from HRMS. Someone whose home IS this
 * screen (attendance only) stays, so it has to carry their whole day: Check
 * in, then Check out, then nothing left to do.
 */
export function punchScreen(
  today: { checkInAt: string | null; checkOutAt: string | null } | null | undefined,
  isHome: boolean,
): PunchScreen {
  if (!today?.checkInAt) return "check-in";
  if (!isHome) return "move-on";
  return today.checkOutAt ? "done" : "check-out";
}
