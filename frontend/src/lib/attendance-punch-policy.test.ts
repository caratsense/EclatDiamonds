import { describe, expect, it } from "vitest";

import { evaluatePunchLocation, punchAction } from "./attendance-punch-policy";

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
});
