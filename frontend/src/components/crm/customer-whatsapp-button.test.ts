import { describe, expect, it } from "vitest";

import { customerConversationHref } from "@/components/crm/customer-whatsapp-button";

/**
 * Where "WhatsApp" on a customer goes (client, 23 Nov: "this whatsapp button in
 * detailed customer view takes to the WhatsApp app. It should take to the
 * conversation tab").
 *
 * Tested here rather than left to the screen because the fault this replaces
 * was INVISIBLE FROM INSIDE THE PRODUCT: the old button opened `wa.me`, the
 * staff member had a perfectly normal conversation from their own WhatsApp
 * account, and the product recorded none of it — no message on the thread, no
 * SLA clock, no audit line. Nothing looked broken to anybody. So the one
 * property that must never regress is asserted directly: every destination is
 * a path inside this product.
 */

describe("where the WhatsApp button on a customer goes", () => {
  it("opens the customer's newest thread in our own inbox", () => {
    expect(
      customerConversationHref({
        partyId: "party_1",
        newestThreadId: "conv_9",
        lookupFailed: false,
      }),
    ).toBe("/conversations?partyId=party_1&thread=conv_9");
  });

  /*
   * `partyId` travels alongside the thread id on purpose. The Conversations
   * screen reads both, and it is `partyId` that produces the "N threads · show
   * all threads" header — without it, a customer with four threads lands on one
   * of them with no sign the other three exist.
   */
  it("keeps the customer filter alongside the thread", () => {
    const href = customerConversationHref({
      partyId: "party_1",
      newestThreadId: "conv_9",
      lookupFailed: false,
    });
    expect(href).toContain("partyId=party_1");
    expect(href).toContain("thread=conv_9");
  });

  it("asks for the template composer when they have never written in", () => {
    // Null, not a URL: WhatsApp refuses free text to a number with no open
    // 24-hour window, so the only thing that can go first is an approved
    // template — and that composer is opened where the user already is.
    expect(
      customerConversationHref({
        partyId: "party_1",
        newestThreadId: null,
        lookupFailed: false,
      }),
    ).toBeNull();
  });

  it("does not treat a failed lookup as 'no thread'", () => {
    expect(
      customerConversationHref({
        partyId: "party_1",
        newestThreadId: null,
        lookupFailed: true,
      }),
    ).toBe("/conversations?partyId=party_1");
  });

  it("never leaves the product", () => {
    for (const input of [
      { partyId: "party_1", newestThreadId: "conv_9", lookupFailed: false },
      { partyId: "party_1", newestThreadId: null, lookupFailed: true },
      { partyId: "party_1", newestThreadId: "conv_9", lookupFailed: true },
    ]) {
      const href = customerConversationHref(input);
      expect(href).toMatch(/^\/conversations\?/);
      expect(href).not.toContain("wa.me");
      expect(href).not.toContain("whatsapp.com");
    }
  });
});
