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
  /** The branch genuinely has no fence configured — the server said so. */
  | { state: "unfenced"; distanceM: null }
  /**
   * The fence could not be read at all.
   *
   * Deliberately NOT the same as "unfenced". Both used to collapse into one
   * state, so a failed request — a 404, a dropped connection, a timeout —
   * looked exactly like a branch with no fence and the punch sailed through
   * from anywhere. Not knowing where somebody is must never be recorded as
   * knowing they are at work.
   */
  | { state: "unknown"; distanceM: null }
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
  // No fence OBJECT at all: the request for it failed or has not landed. That
  // is ignorance, not an absent fence, and it fails safe below.
  if (!fence) return { state: "unknown", distanceM: null };
  if (!fence.hasCoords || fence.latitude == null || fence.longitude == null) {
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
 * Anything the fence cannot confirm needs a written reason. Nothing is
 * refused.
 *
 * A confident outside check-in used to return "block", mirroring a server rule
 * that has now been removed. A phone indoors in a concrete showroom reports
 * 50-150 m of drift, and the stored coordinate is a street centroid rather
 * than the door — so the fence was locking staff out of their own shift rather
 * than catching anybody. It now decides whether a punch is VERIFIED, not
 * whether it may happen, and an unverified punch carries its reason into the
 * manager's regularisation queue.
 *
 * `kind` is no longer read. It stays in the signature because the callers pass
 * it and a tenant-configurable hard fence would need it back; "block" stays in
 * {@link PunchAction} for the same reason, and the screens still render it.
 */
export function punchAction(
  decision: PunchLocationDecision,
  _kind: "in" | "out",
): PunchAction {
  // "unfenced" is a branch the business chose not to fence, and is allowed.
  // "unknown" is a fence we failed to read, and is not — it asks for a reason
  // like every other case the fence cannot confirm.
  if (decision.state === "unfenced" || decision.state === "inside") return "allow";
  return "reason";
}

/** Human distance: nearest 5 m under 1 km, else km with one decimal. */
export function formatDistance(m: number): string {
  if (m >= 1000) {
    return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  }
  return `${Math.round(m / 5) * 5} m`;
}

/**
 * What someone is told when a check-in is refused for distance. It names the
 * branch the distance was measured from: "635 m away" on its own reads as a
 * faulty phone to someone standing in a branch, just not the one they are
 * assigned to, and gives a manager nothing to fix.
 *
 * Kilometres once it is that far, as the distance card on the punch screen
 * says it. Exact metres below: rounded to 5, someone 152 m away would be told
 * they are 150 m from a branch they must be within 150 m of.
 */
export function tooFarMessage(
  branchName: string,
  distanceM: number,
  radiusM: number,
): string {
  const distance = distanceM >= 1000 ? formatDistance(distanceM) : `${distanceM} m`;
  return `You are ${distance} from ${branchName}. Move within ${radiusM} m of it, or ask a manager to fix your attendance.`;
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

/**
 * The shift the punch screen goes on showing, given the one it has kept so far
 * and the latest read of today's attendance.
 *
 * Someone who lives on that screen keeps the first shift it shows them,
 * whatever a later read says. The app reads today's attendance again by itself
 * when the network comes back, as it does on a phone waking in the morning,
 * and after midnight the answer is "nothing today". Shown, that would set the
 * automatic check-in off on a screen nobody has touched. Today starts with a
 * tap instead (isEarlierDay).
 *
 * Everyone else is only passing through, and keeps nothing.
 */
export function keptShift<T extends { checkInAt: string | null }>(
  kept: T | null,
  read: T | null | undefined,
  isHome: boolean,
): T | null {
  return kept ?? (isHome && read?.checkInAt ? read : null);
}

/**
 * Whether the shift on screen belongs to an earlier day at its branch: the
 * server files a punch under the branch's calendar date, so that is the day
 * that counts, not the phone's.
 *
 * Someone who lives on the punch screen leaves it open overnight. Once this is
 * true the screen offers to start today, and it only offers: an open shift
 * keeps its Check out (the server closes the shift it opened, also after
 * midnight), and today's attendance is read again only on a tap.
 */
export function isEarlierDay(
  shift: { date: string; timezone?: string },
  now: Date,
): boolean {
  // en-CA writes a date as YYYY-MM-DD, the form the server sends.
  const today = now.toLocaleDateString(
    "en-CA",
    shift.timezone ? { timeZone: shift.timezone } : undefined,
  );
  return shift.date < today;
}
