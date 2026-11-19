import { describe, expect, it } from "vitest";

import { audienceGate, audienceKey, type AudienceCount } from "./audience-count";
import type { AudiencePreview, SegmentDefinition } from "@/lib/queries/campaigns";

/**
 * The gate that stands between a wizard and a broadcast nobody counted.
 *
 * The client reached Review without pressing "Count who this reaches", read
 * "Audience: Not counted yet", and the send button was still live. So the
 * wizard is walked here the way she walked it — count, step back, edit a rule,
 * return — and the gate's answer is read at each stop.
 */

const preview = (over: Partial<AudiencePreview> = {}): AudiencePreview => ({
  total: 1200,
  contactable: 1150,
  // The figure the preview headlines: contactable, less the blocked.
  sendable: 1150,
  consentCheckedAtSend: true,
  excluded: { noContactPoint: 50, blocked: 0 },
  reasons: [],
  sample: [],
  sampleCapped: true,
  evaluatedAt: "2026-11-19T06:00:00.000Z",
  ...over,
});

/** The wizard's audience state, as the screen holds it. */
function wizard(definition: SegmentDefinition, storeIds: string[] = []) {
  let rules = definition;
  let branches = storeIds;
  let counted: AudienceCount | null = null;
  let counting = false;
  const w = {
    editRule(patch: Partial<SegmentDefinition>) {
      rules = { ...rules, ...patch };
      return w;
    },
    pickBranches(next: string[]) {
      branches = next;
      return w;
    },
    /** Press "Count who this reaches", and let the answer come back. */
    count(result = preview()) {
      counted = { key: audienceKey(rules, branches), preview: result };
      counting = false;
      return w;
    },
    /** The count is in flight. */
    startCount() {
      counting = true;
      return w;
    },
    gate() {
      return audienceGate({ counted, key: audienceKey(rules, branches), counting });
    },
  };
  return w;
}

const customers: SegmentDefinition = {
  match: "all",
  conditions: [{ field: "party.type", op: "in", value: ["customer"] }],
};

describe("sending for approval", () => {
  it("is blocked, in words, until the audience is counted", () => {
    const gate = wizard(customers).gate();
    expect(gate.preview).toBeNull();
    expect(gate.summary).toBe("Not counted yet");
    expect(gate.blocker).toBe("Count who this reaches before sending it for approval.");
  });

  it("is blocked while the count is still running", () => {
    const gate = wizard(customers).startCount().gate();
    expect(gate.summary).toBe("Counting…");
    expect(gate.blocker).toContain("Counting who this reaches");
  });

  it("is allowed once a count for these rules is in", () => {
    const gate = wizard(customers).count().gate();
    expect(gate.blocker).toBeNull();
    expect(gate.summary).toBe("1,200 match, 1,150 contactable");
  });

  it("is blocked when the rules match nobody", () => {
    // A send to nobody is a mistake in the rules, not a send.
    const gate = wizard(customers).count(preview({ total: 0, contactable: 0 })).gate();
    expect(gate.blocker).toBe(
      "These rules match nobody. Change them so the broadcast has someone to reach.",
    );
  });

  it("is blocked when everyone who matches is unreachable", () => {
    const gate = wizard(customers).count(preview({ total: 40, contactable: 0 })).gate();
    expect(gate.blocker).toContain("None of the 40 people who match");
  });
});

describe("a count taken before an edit", () => {
  it("is not presented as this broadcast's audience", () => {
    // Count, go back, swap the rule, return to Review. The old number must not
    // still be sitting there above a live send button.
    const w = wizard(customers).count();
    expect(w.gate().blocker).toBeNull();

    w.editRule({
      conditions: [{ field: "party.city", op: "in", value: ["Indore"] }],
    });

    const gate = w.gate();
    expect(gate.preview).toBeNull();
    expect(gate.stale).toBe(true);
    expect(gate.summary).toBe("The rules changed — counting again");
    expect(gate.blocker).toContain("changed since the last count");
  });

  it("goes stale when the match changes from all to any", () => {
    const w = wizard({
      match: "all",
      conditions: [
        { field: "party.type", op: "in", value: ["customer"] },
        { field: "party.city", op: "in", value: ["Indore"] },
      ],
    }).count();

    w.editRule({ match: "any" });
    expect(w.gate().stale).toBe(true);
  });

  it("goes stale when a branch is added, because a branch narrows the count", () => {
    const w = wizard(customers, ["store_a"]).count();
    w.pickBranches(["store_a", "store_b"]);
    expect(w.gate().stale).toBe(true);
  });

  it("survives the branch buttons being pressed in another order", () => {
    // Same two branches; the order they were switched on in is not the audience.
    const w = wizard(customers, ["store_a", "store_b"]).count();
    w.pickBranches(["store_b", "store_a"]);
    expect(w.gate().stale).toBe(false);
    expect(w.gate().blocker).toBeNull();
  });

  it("counts again cleanly", () => {
    const w = wizard(customers).count();
    w.editRule({ conditions: [{ field: "party.city", op: "in", value: ["Indore"] }] });
    w.count(preview({ total: 90, contactable: 88 }));
    expect(w.gate().stale).toBe(false);
    expect(w.gate().summary).toBe("90 match, 88 contactable");
    expect(w.gate().blocker).toBeNull();
  });
});

describe("the key a count is remembered against", () => {
  it("ignores a rule's missing value the same way twice", () => {
    const withUndefined: SegmentDefinition = {
      match: "all",
      conditions: [{ field: "party.importBatchId", op: "is_set" }],
    };
    const withNull: SegmentDefinition = {
      match: "all",
      conditions: [{ field: "party.importBatchId", op: "is_set", value: null }],
    };
    expect(audienceKey(withUndefined, [])).toBe(audienceKey(withNull, []));
  });

  it("changes when a tag is added to a rule", () => {
    const one: SegmentDefinition = {
      match: "all",
      conditions: [{ field: "party.tag", op: "in", value: ["tag_meta"] }],
    };
    const two: SegmentDefinition = {
      match: "all",
      conditions: [{ field: "party.tag", op: "in", value: ["tag_meta", "tag_walkin"] }],
    };
    expect(audienceKey(one, [])).not.toBe(audienceKey(two, []));
  });

  it("changes when the operator is flipped to an exclusion", () => {
    const has: SegmentDefinition = {
      match: "all",
      conditions: [{ field: "party.tag", op: "in", value: ["tag_meta"] }],
    };
    const hasNot: SegmentDefinition = {
      match: "all",
      conditions: [{ field: "party.tag", op: "not_in", value: ["tag_meta"] }],
    };
    expect(audienceKey(has, [])).not.toBe(audienceKey(hasNot, []));
  });
});
