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
