import { describe, expect, it } from "vitest";

import { isSentBroadcast } from "@/components/crm/broadcast-filter";
import { primaryContactValue } from "@/components/crm/customer-details-dialog";
import {
  fillTemplateBody,
  templateVariableFills,
} from "@/components/crm/send-template-dialog";
import { inboxRefreshTarget } from "@/lib/queries/crm";

/**
 * The three decision rules behind the Conversations fixes (client, 21 Nov).
 *
 * Each one was WRONG IN A WAY NOTHING COULD DETECT, which is why they are
 * tested here rather than left to the screen: a status list that matches no
 * status, a panel that prefers a stale field, and a push filter that is either
 * too narrow (the inbox goes stale again) or too wide (every bell in the
 * building becomes a refetch). All three fail silently.
 */

describe("which broadcasts can be filtered by", () => {
  it("offers a campaign that has reached somebody", () => {
    expect(isSentBroadcast("sending")).toBe(true);
    expect(isSentBroadcast("completed")).toBe(true);
    expect(isSentBroadcast("partially_failed")).toBe(true);
  });

  it("does not offer one that has reached nobody", () => {
    for (const status of [
      "draft",
      "awaiting_approval",
      "approved",
      "scheduled",
      "expanding",
      "queued",
      "cancelled",
      "failed",
    ]) {
      expect(isSentBroadcast(status)).toBe(false);
    }
  });

  /*
   * The bug this replaces, stated as a test so it cannot come back: the filter
   * asked for "sent" and "finished", which are not statuses this product has,
   * and omitted "completed", which is where every finished broadcast ends up.
   * The nails invitation had gone to 203 people and could not be picked.
   */
  it("rejects the statuses the old list invented", () => {
    expect(isSentBroadcast("sent")).toBe(false);
    expect(isSentBroadcast("finished")).toBe(false);
  });
});

describe("the detail a customer is reached on", () => {
  const points = [
    { kind: "whatsapp", value: "+919876543210", isPrimary: true },
    { kind: "phone", value: "+912212345678", isPrimary: false },
    { kind: "email", value: "priya@example.com", isPrimary: true },
  ];

  it("prefers a primary contact point over the party snapshot", () => {
    // What makes a saved correction visible: the dialog writes a primary
    // contact point, and the Party snapshot is NOT updated by that endpoint.
    expect(primaryContactValue(points, ["phone", "whatsapp"], "+910000000000")).toBe(
      "+919876543210",
    );
  });

  it("honours the order of the kinds asked for", () => {
    const withPrimaryPhone = [
      { kind: "phone", value: "+912212345678", isPrimary: true },
      ...points,
    ];
    expect(primaryContactValue(withPrimaryPhone, ["phone", "whatsapp"], null)).toBe(
      "+912212345678",
    );
  });

  it("falls back to the snapshot before a contact point nobody chose", () => {
    const nonePrimary = [{ kind: "phone", value: "+912212345678", isPrimary: false }];
    expect(primaryContactValue(nonePrimary, ["phone"], "+919000000001")).toBe(
      "+919000000001",
    );
    expect(primaryContactValue(nonePrimary, ["phone"], null)).toBe("+912212345678");
  });

  it("returns null rather than inventing an address", () => {
    expect(primaryContactValue(points, ["instagram"], null)).toBeNull();
    expect(primaryContactValue(undefined, ["email"], null)).toBeNull();
    // A blank snapshot is nothing on file, not a value worth printing.
    expect(primaryContactValue([], ["phone"], "   ")).toBeNull();
  });
});

describe("which pushes refresh the inbox", () => {
  it("refreshes the list and the named thread for a conversation push", () => {
    expect(
      inboxRefreshTarget({
        kind: "reminder",
        entityType: "Conversation",
        entityId: "conv_1",
      }),
    ).toEqual({ list: true, conversationId: "conv_1" });
  });

  it("refreshes the list for a new lead even without the entity stamp", () => {
    expect(
      inboxRefreshTarget({ kind: "lead_assigned", entityType: null, entityId: null }),
    ).toEqual({ list: true, conversationId: null });
  });

  it("ignores work that cannot change a conversation", () => {
    for (const kind of ["leave_request", "discount_request", "low_stock", "system"]) {
      expect(
        inboxRefreshTarget({ kind, entityType: "LeaveRequest", entityId: "x" }),
      ).toEqual({ list: false, conversationId: null });
    }
  });
});

describe("sending one template to one customer", () => {
  const defaults = [
    { slot: 1, source: "customer_first_name" as const, fallback: "there" },
    { slot: 2, source: "branch_name" as const, fallback: "our showroom" },
  ];

  it("fills the slots from the template's own recorded defaults", () => {
    expect(
      templateVariableFills(defaults, 2, {
        customerName: "Priya Shah",
        branchName: "Surat — Ring Road",
      }),
    ).toEqual(["Priya", "Surat — Ring Road"]);
  });

  it("uses the template's stand-in when the customer has no name on file", () => {
    // Meta refuses a message with a blank value in it, so the fallback is the
    // difference between a send that reads oddly and one that never arrives.
    expect(
      templateVariableFills(defaults, 2, { customerName: null, branchName: null }),
    ).toEqual(["there", "our showroom"]);
  });

  it("leaves a slot nobody described empty, for the sender to fill", () => {
    // The honest state: the template's author never said what belongs here,
    // and the person sending is the one who can answer.
    expect(templateVariableFills(defaults, 3, { customerName: "Priya" })).toEqual([
      "Priya",
      "our showroom",
      "",
    ]);
    expect(templateVariableFills(undefined, 1, { customerName: "Priya" })).toEqual([""]);
  });

  it("sends the same wording for everyone as written", () => {
    expect(
      templateVariableFills(
        [{ slot: 1, source: "fixed", text: "Diwali Collection", fallback: "Diwali Collection" }],
        1,
        { customerName: "Priya" },
      ),
    ).toEqual(["Diwali Collection"]);
  });

  it("collapses a value the provider would refuse", () => {
    // A name saved with a line break in it is still one parameter to Meta.
    expect(
      templateVariableFills(defaults, 1, { customerName: "Priya\n  Shah" }),
    ).toEqual(["Priya"]);
  });

  it("asks for nothing when the template takes nothing", () => {
    expect(templateVariableFills(defaults, 0, { customerName: "Priya" })).toEqual([]);
  });

  it("shows the sender the sentence the customer will read", () => {
    expect(
      fillTemplateBody("Hello {{1}}, your order at {{2}} is ready.", ["Priya", "Surat"]),
    ).toBe("Hello Priya, your order at Surat is ready.");
  });

  it("keeps an unfilled placeholder visible rather than swallowing it", () => {
    // A gap has to look like a gap: collapsing {{2}} to nothing would read as
    // a finished sentence and go out with a hole in it.
    expect(fillTemplateBody("Hello {{1}}, see you at {{2}}.", ["Priya", "  "])).toBe(
      "Hello Priya, see you at {{2}}.",
    );
    expect(fillTemplateBody("Hello {{1}}.", [])).toBe("Hello {{1}}.");
  });

  it("reads a placeholder written with spaces inside it", () => {
    expect(fillTemplateBody("Hello {{ 1 }}.", ["Priya"])).toBe("Hello Priya.");
  });
});
