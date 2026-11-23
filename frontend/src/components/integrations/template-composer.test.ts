import { describe, expect, it } from "vitest";

import {
  incompleteDefaultSlot,
  variableDefaultsFor,
  type VariableDefaultRow,
} from "@/components/integrations/template-composer";

/**
 * What the template remembers about its own variables.
 *
 * The client wrote a template whose body was `{{1}}`, gave "Priya" as the
 * sample, and asked where she says that this is a customer's name. The sample
 * is for Meta's reviewer and is never sent; the answer is now recorded on the
 * template and pre-selected on every broadcast.
 *
 * Which makes the mapping below load-bearing in a way the sample never was. A
 * stored default is read by every future send of this template, so a row
 * invented here would put words in her mouth for as long as the template
 * exists — these two functions are the whole of that decision, which is why
 * they are pure and tested rather than inline in a dialog.
 */
const rows = (r: Record<number, VariableDefaultRow>) => r;

describe("variableDefaultsFor", () => {
  it("sends nothing for a variable left to each broadcast", () => {
    // The dropdown's "Decide on each broadcast" row stores no choice at all.
    // A row naming a source nobody picked would be stored and then
    // pre-selected for ever, which is worse than having no default.
    expect(variableDefaultsFor([1, 2], rows({ 2: { source: "branch_name", fallback: "our store" } })))
      .toEqual([{ slot: 2, source: "branch_name", fallback: "our store" }]);
  });

  it("carries a fixed wording and no stand-in", () => {
    /*
     * A fixed value is never empty, so it is its own stand-in and the server
     * fills that in. Sending a fallback beside it would be sending one that can
     * never be reached.
     */
    expect(
      variableDefaultsFor(
        [1],
        rows({ 1: { source: "fixed", text: " Diwali collection ", fallback: "there" } }),
      ),
    ).toEqual([{ slot: 1, source: "fixed", text: "Diwali collection" }]);
  });

  it("drops a choice for a variable that has been deleted from the body", () => {
    // The body is the authority on which slots exist. A leftover row for a
    // removed {{2}} is refused by the server with a sentence about a variable
    // that is no longer on the screen, which reads as a bug.
    expect(
      variableDefaultsFor(
        [1],
        rows({
          1: { source: "customer_first_name", fallback: "there" },
          2: { source: "branch_name", fallback: "our store" },
        }),
      ),
    ).toEqual([{ slot: 1, source: "customer_first_name", fallback: "there" }]);
  });
});

describe("incompleteDefaultSlot", () => {
  it("passes a variable with no default at all", () => {
    expect(incompleteDefaultSlot([1], rows({}))).toBeUndefined();
  });

  it("catches a customer value with no stand-in", () => {
    /*
     * Meta refuses a parameter that is an empty string. Without this the
     * template saves, the broadcast pre-selects the row, and the send fails on
     * exactly the customers who have no name recorded — per recipient, after
     * the campaign is already running.
     */
    expect(incompleteDefaultSlot([1], rows({ 1: { source: "customer_name", fallback: "  " } }))).toBe(1);
  });

  it("catches a fixed row with no wording", () => {
    expect(incompleteDefaultSlot([1], rows({ 1: { source: "fixed", text: "" } }))).toBe(1);
  });

  it("reports the first unfinished one, which is the one to point at", () => {
    expect(
      incompleteDefaultSlot(
        [1, 2],
        rows({
          1: { source: "customer_first_name", fallback: "there" },
          2: { source: "branch_name", fallback: "" },
        }),
      ),
    ).toBe(2);
  });
});
