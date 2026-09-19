import { describe, expect, it } from "vitest";

import { connectionView } from "./catalogue-connection";

describe("website connection view", () => {
  it("says Connected only for a verified connection", () => {
    expect(connectionView("connected").label).toBe("Connected");
    for (const s of ["not_configured", "failed", "needs_attention", "sync_running", null, undefined] as const) {
      expect(connectionView(s).label).not.toBe("Connected");
    }
  });

  it("shows Checking while a probe is in flight, whatever the last state was", () => {
    expect(connectionView("connected", true).label).toBe("Checking…");
    expect(connectionView("failed", true).label).toBe("Checking…");
  });

  it("gives every state a next step", () => {
    for (const s of ["not_configured", "connected", "sync_running", "needs_attention", "failed"] as const) {
      expect(connectionView(s).help.length).toBeGreaterThan(10);
    }
  });
});
