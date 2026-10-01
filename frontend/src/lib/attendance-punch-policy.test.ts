import { describe, expect, it } from "vitest";

import {
  evaluatePunchLocation,
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

  it("blocks a precise outside check-in but lets checkout continue with a reason", () => {
    const decision = evaluatePunchLocation({ lat: 0, lng: 0.01, accuracyM: 5 }, fence);
    expect(decision.state).toBe("outside");
    expect(punchAction(decision, "in")).toBe("block");
    expect(punchAction(decision, "out")).toBe("reason");
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
    expect(punchScreen(checkedIn, false)).toBe("move-on");
    expect(punchScreen(checkedOut, false)).toBe("move-on");
  });
});
