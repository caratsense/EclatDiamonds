import { describe, expect, it } from "vitest";

import {
  evaluatePunchLocation,
  isEarlierDay,
  keptShift,
  punchAction,
  punchScreen,
  tooFarMessage,
} from "./attendance-punch-policy";

const fence = {
  hasCoords: true,
  latitude: 0,
  longitude: 0,
  geofenceRadiusM: 100,
};

describe("attendance punch location policy", () => {

  it("allows an unfenced store without manufacturing a location requirement", () => {
    const decision = evaluatePunchLocation(null, { ...fence, hasCoords: false });
    expect(decision.state).toBe("unfenced");
    expect(punchAction(decision, "in")).toBe("allow");
  });

  it("requires a reason when a configured fence has no GPS fix", () => {
    const decision = evaluatePunchLocation(null, fence);
    expect(decision.state).toBe("unavailable");
    expect(punchAction(decision, "in")).toBe("reason");
    expect(punchAction(decision, "out")).toBe("reason");
  });

  it("allows a precise fix inside the fence", () => {
    const decision = evaluatePunchLocation({ lat: 0, lng: 0, accuracyM: 5 }, fence);
    expect(decision.state).toBe("inside");
    expect(punchAction(decision, "in")).toBe("allow");
  });

  it("records a precise outside punch with a reason, in either direction", () => {
    /*
     * This asserted that an outside check-in was BLOCKED, mirroring the server
     * rule of the day. It locked staff out of their own shift: a phone indoors
     * at Roha Orion reports 50-150 m of drift against a coordinate that is a
     * street centroid, so somebody at the counter was told they were 635 m
     * away. The fence now decides whether a punch is verified, not whether it
     * is permitted — so neither direction is refused, and both carry a reason
     * into the manager's queue.
     */
    const decision = evaluatePunchLocation({ lat: 0, lng: 0.01, accuracyM: 5 }, fence);
    expect(decision.state).toBe("outside");
    expect(punchAction(decision, "in")).toBe("reason");
    expect(punchAction(decision, "out")).toBe("reason");
  });

  it("does NOT treat a fence it could not load as 'no fence'", () => {
    /*
     * The bug this exists to stop. `GET /hrms/geofence` returned 404 whenever
     * the store header was missing or "All Stores", the screen could not tell
     * a failed lookup from a branch with no fence, and the punch went through
     * from anywhere with nothing asked. Not knowing where somebody is must
     * never be recorded as knowing they are at work.
     */
    for (const missing of [undefined, null]) {
      const d = evaluatePunchLocation({ lat: 0, lng: 0, accuracyM: 5 }, missing);
      expect(d.state).toBe("unknown");
      expect(punchAction(d, "in")).toBe("reason");
      expect(punchAction(d, "out")).toBe("reason");
    }
  });

  it("still allows a branch the business genuinely left unfenced", () => {
    // The server saying "this branch has no coordinates" is an answer, not a
    // failure, and must stay frictionless.
    const d = evaluatePunchLocation(
      { lat: 0, lng: 0, accuracyM: 5 },
      { hasCoords: false, latitude: null, longitude: null, geofenceRadiusM: 150 },
    );
    expect(d.state).toBe("unfenced");
    expect(punchAction(d, "in")).toBe("allow");
  });

  it("never refuses a punch outright", () => {
    // The guarantee the showroom actually needs, asserted directly so a future
    // edit that reintroduces a hard block fails here rather than on the floor.
    for (const pos of [
      { lat: 0, lng: 0.01, accuracyM: 5 },
      { lat: 0, lng: 0.00045, accuracyM: 200 },
      { lat: 0, lng: 0, accuracyM: 5 },
    ]) {
      const d = evaluatePunchLocation(pos, fence);
      expect(punchAction(d, "in")).not.toBe("block");
      expect(punchAction(d, "out")).not.toBe("block");
    }
    expect(punchAction(evaluatePunchLocation(null, fence), "in")).not.toBe("block");
  });

  it("requires a reason when GPS uncertainty overlaps the fence", () => {
    const decision = evaluatePunchLocation({ lat: 0, lng: 0.00045, accuracyM: 200 }, fence);
    expect(decision.state).toBe("imprecise");
    expect(punchAction(decision, "in")).toBe("reason");
  });

  it("names the branch a refused check-in was measured from", () => {
    // Staff standing in one branch but assigned to another were told only
    // "635 m away", which nobody could act on.
    const message = tooFarMessage("Surat Main", 635, 150);
    expect(message).toContain("635 m from Surat Main");
    expect(message).toContain("150 m");
  });

  it("gives that distance in kilometres once it is that far, and exactly below", () => {
    // The way the distance card on the punch screen writes it, not "2480 m".
    expect(tooFarMessage("Surat Main", 2480, 150)).toContain("2.5 km from Surat Main");
    expect(tooFarMessage("Surat Main", 12480, 150)).toContain("12 km from Surat Main");
    // Rounded to 5 m, this would be "150 m from" a branch to be within 150 m of.
    expect(tooFarMessage("Surat Main", 152, 150)).toContain("152 m from Surat Main");
  });
});

describe("the punch screen, by today's punches", () => {
  const checkedIn = { checkInAt: "2026-10-01T04:32:00.000Z", checkOutAt: null };
  const checkedOut = { ...checkedIn, checkOutAt: "2026-10-01T13:05:00.000Z" };

  it("asks anyone who has not punched to check in", () => {
    expect(punchScreen(null, true)).toBe("check-in");
    expect(punchScreen(null, false)).toBe("check-in");
    // A row a manager created (on leave, absent) is not a punch.
    expect(punchScreen({ checkInAt: null, checkOutAt: null }, true)).toBe("check-in");
  });

  it("keeps someone whose home is this screen: check out, then done", () => {
    expect(punchScreen(checkedIn, true)).toBe("check-out");
    expect(punchScreen(checkedOut, true)).toBe("done");
  });

  it("sends everyone else on to their own home once they are in", () => {
    // The punch screen's redirect is this answer and nothing else.
    expect(punchScreen(checkedIn, false)).toBe("move-on");
    expect(punchScreen(checkedOut, false)).toBe("move-on");
  });
});

describe("a shift left on the punch screen overnight", () => {
  const checkedIn = { checkInAt: "2026-10-01T04:32:00.000Z", checkOutAt: null };

  it("stays on the screen of someone who lives there when a later read says nothing today", () => {
    // The first read of the day shows the shift, and it is kept.
    const kept = keptShift(null, checkedIn, true);
    expect(kept).toBe(checkedIn);
    // The phone wakes after midnight and the app reads again: no record for the
    // new day. Showing that would start the automatic check-in with no tap.
    expect(keptShift(kept, null, true)).toBe(checkedIn);
    expect(punchScreen(keptShift(kept, null, true), true)).toBe("check-out");
  });

  it("is not kept for everyone else, nor is a record that is not a punch", () => {
    expect(keptShift(null, checkedIn, false)).toBeNull();
    // A row a manager created (on leave, absent) has no check-in to keep.
    expect(keptShift(null, { checkInAt: null, checkOutAt: null }, true)).toBeNull();
    expect(keptShift(null, undefined, true)).toBeNull();
  });

  it("is an earlier day's once the date has changed at its branch", () => {
    const shift = { date: "2026-10-01", timezone: "Asia/Kolkata" };
    // 23:59 and 00:01 in Kolkata, whatever zone the phone (or this test) is in.
    expect(isEarlierDay(shift, new Date("2026-10-01T18:29:00.000Z"))).toBe(false);
    expect(isEarlierDay(shift, new Date("2026-10-01T18:31:00.000Z"))).toBe(true);
  });

  it("goes by the phone's own date when the record names no timezone", () => {
    const shift = { date: "2026-10-01" };
    expect(isEarlierDay(shift, new Date(2026, 9, 1, 23, 59))).toBe(false);
    expect(isEarlierDay(shift, new Date(2026, 9, 2, 0, 1))).toBe(true);
  });
});
