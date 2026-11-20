import { describe, expect, it } from "vitest";

import { sendFailureReason } from "./message-status";

/**
 * What the thread tells the person who pressed send.
 *
 * A store manager sent one customer the same photograph three times in under a
 * minute: all three had already failed, the bubble showed a waiting timer, and
 * the only reason on the screen was a tooltip on a 12-pixel icon. These
 * assertions are about the sentence that replaced it — it has to read as an
 * instruction to somebody standing in front of a customer, not as a log line.
 */
describe("why a message did not reach the customer", () => {
  it("drops the engineer's code and keeps the sentence", () => {
    expect(
      sendFailureReason("content_missing: The queued message has neither text nor an attachment to send."),
    ).toBe("The queued message has neither text nor an attachment to send.");
  });

  it("keeps a reason that carries no code, rather than summarising it away", () => {
    expect(sendFailureReason("Provider error 131042")).toBe("Provider error 131042");
  });

  it("keeps a provider reason whose prefix is not a code", () => {
    expect(sendFailureReason("HTTP 400: Parameter format does not match")).toBe(
      "HTTP 400: Parameter format does not match",
    );
  });

  it("says something useful when nothing was recorded at all", () => {
    for (const nothing of [null, undefined, "", "   "]) {
      expect(sendFailureReason(nothing)).toBe(
        "WhatsApp did not accept it. Try again, or ring the customer.",
      );
    }
  });

  it("keeps every line of a multi-line refusal", () => {
    expect(sendFailureReason("template_unavailable: Not approved.\nSynchronise templates.")).toBe(
      "Not approved.\nSynchronise templates.",
    );
  });
});
