import { describe, expect, it } from "vitest";

import {
  availableActions,
  initiatingStoreId,
  type StockTransfer,
  type TransferStatus,
} from "@/lib/queries/stock-transfers";

/**
 * The buttons on a transfer, when the transfer is a request to another branch.
 *
 * The screen must not promise what the server will not do: the backend lets the
 * HOLDING branch's manager accept or decline a pull, and nobody else — not the
 * branch that asked, not head office, and not the person who raised it even
 * when they happen to manage both branches.
 */

const BANDRA = "mumbai-bandra";
const BORIVALI = "mumbai-borivali";

function pull(status: TransferStatus, requestedById = "u-sales"): StockTransfer {
  return {
    id: "tr-1",
    ref: "ST-A001 MUBD-001",
    status,
    reason: null,
    initiatedBy: "destination",
    // Borivali holds the piece; Bandra asked for it.
    fromStoreId: BORIVALI,
    fromStoreName: "MUMBAI BORIVALI",
    toStoreId: BANDRA,
    toStoreName: "MUMBAI BANDRA",
    itemCount: 1,
    items: [],
    requestedBy: {
      id: requestedById,
      name: "Rhea",
      role: "salesperson",
      roleLabel: "Salesperson",
    },
    sourceDecidedBy: null,
    approvedBy: null,
    dispatchedBy: null,
    receivedBy: null,
    acknowledgedBy: null,
    submittedAt: null,
    sourceDecidedAt: null,
    approvedAt: null,
    dispatchedAt: null,
    receivedAt: null,
    acknowledgedAt: null,
    createdAt: "2026-11-20T04:00:00.000Z",
    updatedAt: "2026-11-20T04:00:00.000Z",
  };
}

/** The same record as the push it would have been: Borivali sending it over. */
function push(status: TransferStatus): StockTransfer {
  return { ...pull(status, "u-bori-mgr"), initiatedBy: "source" };
}

const labels = (metas: { label: string }[]) => metas.map((m) => m.label);

describe("who may act on a pull", () => {
  it("the branch that asked raises and sends it", () => {
    const t = pull("draft");
    // The salesperson who raised it: the person with the customer in front of
    // them, who would otherwise wait for a manager to notice a draft.
    expect(labels(availableActions(t, "salesperson", new Set([BANDRA]), "u-sales"))).toEqual([
      "Send request",
    ]);
    // Somebody else's draft is not theirs to send.
    expect(availableActions(t, "salesperson", new Set([BANDRA]), "u-other")).toEqual([]);
  });

  it("the holding branch accepts or declines, and declining is just as easy", () => {
    const actions = availableActions(
      pull("pending_source"),
      "store_manager",
      new Set([BORIVALI]),
      "u-bori-mgr",
    );
    expect(labels(actions)).toEqual(["Accept request", "Decline"]);
    const decline = actions.find((a) => a.action === "decline");
    // One click to a reason box, not an escalation — and not styled as damage.
    expect(decline?.needsReason).toBe(true);
    expect(decline?.variant).toBe("outline");
  });

  it("the branch that asked cannot accept its own request", () => {
    const actions = availableActions(
      pull("pending_source"),
      "store_manager",
      new Set([BANDRA]),
      "u-bandra-mgr",
    );
    expect(labels(actions)).toEqual(["Cancel"]);
  });

  it("a manager who runs both branches still cannot answer their own ask", () => {
    const t = pull("pending_source", "u-both");
    const actions = availableActions(
      t,
      "store_manager",
      new Set([BANDRA, BORIVALI]),
      "u-both",
    );
    expect(labels(actions)).not.toContain("Accept request");
    expect(labels(actions)).not.toContain("Decline");
  });

  it("a second manager at the holding branch can answer it", () => {
    const t = pull("pending_source", "u-both");
    const actions = availableActions(t, "store_manager", new Set([BORIVALI]), "u-kunal");
    expect(labels(actions)).toEqual(["Accept request", "Decline"]);
  });

  it("head office sees nothing until the branch has agreed", () => {
    expect(availableActions(pull("pending_source"), "head_office", new Set(), "u-ho")).toEqual([]);
    expect(
      labels(availableActions(pull("submitted"), "head_office", new Set(), "u-ho")),
    ).toEqual(["Approve", "Reject"]);
  });

  it("an answered pull offers nothing further", () => {
    for (const status of ["declined", "rejected", "cancelled"] as TransferStatus[]) {
      expect(
        availableActions(pull(status), "store_manager", new Set([BORIVALI]), "u-bori-mgr"),
      ).toEqual([]);
    }
  });
});

describe("the movement itself is unchanged", () => {
  it("a push still submits, dispatches and cancels from the source", () => {
    expect(
      labels(availableActions(push("draft"), "store_manager", new Set([BORIVALI]), "u-bori-mgr")),
    ).toEqual(["Submit to HO", "Cancel"]);
    expect(
      labels(
        availableActions(push("ho_approved"), "store_manager", new Set([BORIVALI]), "u-bori-mgr"),
      ),
    ).toEqual(["Cancel", "Dispatch"]);
  });

  it("an accepted pull is dispatched and received exactly like a push", () => {
    // The pieces still have to physically move and be signed for, by the same
    // two branches in the same two roles.
    expect(
      labels(
        availableActions(pull("ho_approved"), "store_manager", new Set([BORIVALI]), "u-bori-mgr"),
      ),
    ).toEqual(["Dispatch"]);
    expect(
      labels(
        availableActions(pull("dispatched"), "store_manager", new Set([BANDRA]), "u-bandra-mgr"),
      ),
    ).toEqual(["Mark received"]);
    expect(
      labels(
        availableActions(pull("received"), "store_manager", new Set([BANDRA]), "u-bandra-mgr"),
      ),
    ).toEqual(["Acknowledge"]);
  });

  it("names the branch that raised it, whichever end that is", () => {
    expect(initiatingStoreId(pull("draft"))).toBe(BANDRA);
    expect(initiatingStoreId(push("draft"))).toBe(BORIVALI);
  });
});
