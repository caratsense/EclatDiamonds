import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Quote } from "@/lib/mock/quotation";

import { QuoteCustomerFields } from "./quote-customer-fields";
import { QuoteCustomerPanel } from "./quote-customer-panel";
import { SendQuoteDialog, sendOutcome } from "./send-quote-dialog";
import { customerProblems } from "./quote-validation";

/**
 * The customer on a quotation, after the quotation exists.
 *
 * The customer used to be frozen at creation: a mis-keyed name or a wrong digit
 * meant raising the quote again and losing the agreed price. Three things are
 * asserted here, and they are the three that went wrong:
 *
 *  1. The rules are ONE set of rules. The New-quote modal and the customer edit
 *     both ask `customerProblems`, so a name or number one accepts can never be
 *     refused by the other — which is how a customer gets stuck half-corrected.
 *  2. The boxes are ONE set of boxes, in one order. Name, phone, then the
 *     address across the full width, h-11 in both places.
 *  3. Nothing in either flow waits on anybody. No approval, no manager, and no
 *     primary button that is disabled because of a standing.
 */

const quote = (patch: Partial<Quote> = {}): Quote => ({
  id: "q1",
  ref: "QT-2042",
  customer: "Meera Iyer",
  phone: "9812370042",
  customerAddress: "14 Ring Road, Indore",
  originStoreId: "s1",
  redeemableStoreIds: ["s1"],
  status: "shared",
  kind: "sale",
  isKaccha: false,
  remarks: "",
  grossWeightG: null,
  photos: [],
  createdAt: "2026-10-14",
  validUntil: "2026-10-28",
  assignedRep: "Rep",
  lines: [],
  revision: 3,
  ...patch,
});

/** Server-rendered markup; these components hold a mutation, hence the client. */
const render = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      node,
    ),
  );

describe("the three boxes, wherever they are shown", () => {
  const markup = render(
    createElement(QuoteCustomerFields, {
      idPrefix: "qb",
      value: { name: "Meera Iyer", phone: "9812370042", address: "14 Ring Road" },
      onChange: () => {},
    }),
  );

  it("asks for the name, then the phone, then the address", () => {
    const order = ["qb-cust", "qb-phone", "qb-address"].map((id) => markup.indexOf(`id="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("labels all three, and marks the two that are required", () => {
    expect(markup).toContain("Customer name");
    expect(markup).toContain("Phone");
    expect(markup).toContain("Customer address");
    // One asterisk for the name and one for the phone; the address is optional.
    expect(markup.match(/\*/g) ?? []).toHaveLength(2);
  });

  it("sizes every box for a counter touchscreen", () => {
    expect(markup.match(/h-11/g) ?? []).toHaveLength(3);
  });

  it("gives the address the full width, on its own row", () => {
    // The name and phone share a two-column grid; the address is outside it.
    const grid = markup.indexOf("sm:grid-cols-2");
    expect(grid).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('id="qb-address"')).toBeGreaterThan(grid);
  });

  it("shows the current values, so an edit starts from what is on the quote", () => {
    expect(markup).toContain('value="Meera Iyer"');
    expect(markup).toContain('value="9812370042"');
    expect(markup).toContain('value="14 Ring Road"');
  });

  it("puts the per-field complaint under the box it belongs to", () => {
    const withErrors = render(
      createElement(QuoteCustomerFields, {
        idPrefix: "qc",
        value: { name: "46466", phone: "12345", address: "" },
        errors: customerProblems({ name: "46466", phone: "12345" }),
        onChange: () => {},
      }),
    );
    expect(withErrors).toContain("Enter a valid name (letters, not just numbers).");
    expect(withErrors).toContain("Enter a 10-digit mobile, or an international number starting with +.");
    expect(withErrors.match(/aria-invalid="true"/g) ?? []).toHaveLength(2);
  });
});

describe("the customer edit on a saved quote", () => {
  it("shows who the quote is for, and offers to change it", () => {
    const markup = render(createElement(QuoteCustomerPanel, { quote: quote() }));
    expect(markup).toContain("Customer");
    expect(markup).toContain("Meera Iyer");
    expect(markup).toContain("9812370042");
    expect(markup).toContain("14 Ring Road, Indore");
    expect(markup).toContain("Edit customer");
  });

  it("offers the edit on a quote that was already shared", () => {
    expect(render(createElement(QuoteCustomerPanel, { quote: quote({ status: "shared" }) }))).toContain(
      "Edit customer",
    );
  });

  /*
   * The one standing that could have been protected. The server allows the
   * correction (money and the spelling for the certificate both arrive after
   * the order is booked) and refuses only a new PRICE, so the screen must not
   * invent a stricter rule of its own.
   */
  it("offers it on an accepted quote too, which is what the server allows", () => {
    expect(
      render(createElement(QuoteCustomerPanel, { quote: quote({ status: "accepted" }) })),
    ).toContain("Edit customer");
  });

  it("says plainly that it is not the price", () => {
    const markup = render(createElement(QuoteCustomerPanel, { quote: quote() }));
    expect(markup).toContain("The price and the revision stay as they are");
  });

  it("waits on nobody: no approval, no manager, no disabled edit", () => {
    for (const status of ["draft", "shared", "accepted"] as const) {
      const markup = render(createElement(QuoteCustomerPanel, { quote: quote({ status }) }));
      expect(markup).not.toMatch(/approv/i);
      expect(markup).not.toMatch(/manager/i);
      // The attribute, not the `disabled:` utility classes every button carries.
      expect(markup).not.toMatch(/<button[^>]*\sdisabled[\s=>]/);
    }
  });
});

/**
 * The send dialog's markup cannot be asserted on here: Radix renders dialog
 * content through a portal, which a server render produces nothing for, and the
 * runner is deliberately DOM-less (see vitest.config.ts). What matters most
 * about the send is not markup anyway — it is the sentence the person is left
 * with, which is a pure function of the server's answer.
 */
describe("what the sender is told about a send", () => {
  const result = {
    queued: true,
    ref: "QT-2042",
    revision: 3,
    messageId: "m1",
    status: "queued",
    dryRun: false,
  };

  it("says queued, never sent — WhatsApp still decides", () => {
    const out = sendOutcome(result, "9812370042");
    expect(out.tone).toBe("success");
    expect(out.title).toBe("Quote QT-2042 PDF queued for WhatsApp");
    expect(out.title).not.toMatch(/\bsent\b|\bdelivered\b/i);
    expect(out.description).not.toMatch(/\bsent\b|\bdelivered\b/i);
  });

  it("repeats the server's own status word and the number it went to", () => {
    const out = sendOutcome({ ...result, status: "held" }, " 9812370042 ");
    expect(out.description).toContain("status held");
    expect(out.description).toContain("9812370042");
  });

  it("warns, and does not claim a send, when WhatsApp is not connected", () => {
    const out = sendOutcome({ ...result, dryRun: true }, "9812370042");
    expect(out.tone).toBe("warning");
    expect(out.title).toContain("will not be delivered");
    expect(out.title).not.toMatch(/queued for WhatsApp/);
    // And it says what to do instead, rather than leaving a dead end.
    expect(out.description).toContain("Download the PDF");
  });

  it("never mentions an approval or a manager in either outcome", () => {
    for (const dryRun of [false, true]) {
      const out = sendOutcome({ ...result, dryRun }, "9812370042");
      expect(`${out.title} ${out.description}`).not.toMatch(/approv|manager/i);
    }
  });

  it("stays closed until there is a quote to send", () => {
    expect(render(createElement(SendQuoteDialog, { target: null, onClose: () => {} }))).toBe("");
  });
});
