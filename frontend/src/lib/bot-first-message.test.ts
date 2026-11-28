import { describe, expect, it } from "vitest";

import {
  firstCustomerMessage,
  firstCustomerMessageSends,
} from "@/lib/bot-first-message";

/**
 * The report, 28 Nov: "the bot is not sending the message as we have set on the
 * bot script".
 *
 * Her three live bridal campaigns have an empty first reply, no questions and
 * only a closing message, so the first message every customer receives is that
 * closing message — exactly what the sender does. These are the cases the
 * preview in the bot-script editor is built on, and the same cases
 * `campaign-first-message.spec.ts` pins on the server, so the screen and the
 * sender cannot drift apart without one of the two failing.
 */
describe("the first message a customer receives", () => {
  it("sends the first reply word for word when one is written", () => {
    expect(
      firstCustomerMessage({
        firstReply: "Hi! The solitaire from our ad starts at ₹85,000 for 0.5 carat.",
      }),
    ).toEqual({
      source: "firstReply",
      text: "Hi! The solitaire from our ad starts at ₹85,000 for 0.5 carat.",
    });
  });

  it("attaches the first question to that opener", () => {
    expect(
      firstCustomerMessage({
        firstReply: "Hi! Our bridal sets start at ₹1,20,000.",
        questions: [{ text: "Which carat size are you considering?" }],
      }).text,
    ).toBe("Hi! Our bridal sets start at ₹1,20,000.\n\nWhich carat size are you considering?");
    // An opener that already asks something keeps its own question.
    expect(
      firstCustomerMessage({
        firstReply: "Hi! What are you shopping for?",
        questions: [{ text: "Which carat size are you considering?" }],
      }).text,
    ).toBe("Hi! What are you shopping for?");
  });

  it("opens with the CLOSING message when that is all there is", () => {
    // The exact shape of all three bridal campaigns, and the whole of the
    // complaint: the closing line IS the first message, because nothing
    // precedes it.
    const first = firstCustomerMessage({
      firstReply: null,
      questions: [],
      closingMessage: "Hello! Thank you for your interest in Nibhana's bridal collection.",
    });
    expect(first).toEqual({
      source: "closingMessage",
      text: "Hello! Thank you for your interest in Nibhana's bridal collection.",
    });
    expect(firstCustomerMessageSends(first)).toBe(true);
  });

  it("opens with the first question when there is no first reply", () => {
    expect(firstCustomerMessage({ questions: [{ text: "Which branch is nearest you?" }] })).toEqual({
      source: "question",
      text: "Which branch is nearest you?",
    });
    // Choices ride inside the sentence, never as a menu.
    expect(
      firstCustomerMessage({
        questions: [{ text: "Which carat size?", options: ["under 1", "1 to 1.5", "above 1.5"] }],
      }).text,
    ).toBe("Which carat size — under 1, 1 to 1.5, above 1.5?");
  });

  it("promises no exact words once the assistant answers unopened", () => {
    expect(
      firstCustomerMessage({ aiReplies: true, questions: [{ text: "Which carat size?" }] }),
    ).toEqual({ source: "assistant", text: null });
  });

  it("says loudly that nothing is sent when nothing is filled in", () => {
    for (const draft of [
      {},
      { firstReply: null, questions: [], closingMessage: null },
      // Whitespace is not a configured message, on the server either.
      { firstReply: "", closingMessage: "   " },
    ]) {
      const first = firstCustomerMessage(draft);
      expect(first).toEqual({ source: "none", text: null });
      expect(firstCustomerMessageSends(first)).toBe(false);
    }
  });

  it("separates a script that is off from one that was never written", () => {
    // Both send nothing, and the writer has to be told which: one needs
    // switching on, the other needs writing.
    expect(
      firstCustomerMessage({
        enabled: false,
        firstReply: "Hi! Our bridal sets start at ₹1,20,000.",
      }).source,
    ).toBe("off");
    expect(
      firstCustomerMessage({
        handling: "human",
        firstReply: "Hi! Our bridal sets start at ₹1,20,000.",
      }).source,
    ).toBe("humanOnly");
  });

  it("calls out a script whose message would arrive empty", () => {
    // A first reply of nothing but spaces counts as configured (the closing
    // message opted the rule in) and goes out as it stands, so the customer
    // gets a blank WhatsApp message.
    const first = firstCustomerMessage({
      firstReply: "   ",
      closingMessage: "Our team will reply here.",
    });
    expect(first.source).toBe("blank");
    expect(firstCustomerMessageSends(first)).toBe(false);
  });
});
