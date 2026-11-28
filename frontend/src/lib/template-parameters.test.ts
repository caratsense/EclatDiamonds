import { describe, expect, it } from "vitest";

import {
  flattenTemplateParameter,
  templateParameterComponents,
} from "@/lib/template-parameters";

/**
 * What a template send actually puts on the wire.
 *
 * 28 Nov: the client sent "newmessage" from a thread with "Sneha" typed into
 * `{{1}}`, and the stored row held `templateComponents: [[]]`. She saw the
 * template's own wording in the inbox — "Hello {{1}}, hope you are having a
 * good day!" — and concluded a customer had been sent a literal placeholder.
 *
 * The browser's half was right and the server's request pipeline broke it. But
 * the shaping lived inline inside `useSendTemplateReply`, where no test could
 * reach it, so nothing on this side ever stated what the body must contain.
 * These assertions are that statement. They are on the exact JSON, because
 * `[[]]` is what an object looks like AFTER serialisation and before it the
 * fault is invisible.
 */
describe("the component block a template send carries", () => {
  it("puts one value in the shape Meta takes", () => {
    expect(templateParameterComponents(["Sneha"])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Sneha" }] },
    ]);
  });

  it("keeps several values in slot order, which is positional at Meta", () => {
    // A reordered array sends the quote reference as the customer's name, and
    // nothing downstream can tell.
    expect(templateParameterComponents(["Sneha Chouksey", "Q-1042", "₹1,24,500"])).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Sneha Chouksey" },
          { type: "text", text: "Q-1042" },
          { type: "text", text: "₹1,24,500" },
        ],
      },
    ]);
  });

  it("survives JSON, which is where the 28 Nov values were lost", () => {
    const sent = JSON.parse(JSON.stringify(templateParameterComponents(["Sneha"])));
    expect(sent).toEqual([{ type: "body", parameters: [{ type: "text", text: "Sneha" }] }]);
    // The shape of the fault, asserted against directly.
    expect(sent).not.toEqual([[]]);
  });

  it("leaves an emoji exactly as typed", () => {
    expect(templateParameterComponents(["Sneha 💎"])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Sneha 💎" }] },
    ]);
  });

  it("collapses a newline rather than letting Meta refuse the message", () => {
    // Meta rejects a parameter containing a newline, a tab or four consecutive
    // spaces (#132000). The words reach the customer on one line instead of not
    // reaching her at all.
    expect(templateParameterComponents(["Sneha\nChouksey"])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Sneha Chouksey" }] },
    ]);
    expect(templateParameterComponents(["Sneha\tji", "Indore    branch"])).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Sneha ji" },
          { type: "text", text: "Indore branch" },
        ],
      },
    ]);
  });

  it("sends a whitespace-only value as the blank it is, for the server to name", () => {
    /*
     * Not repaired here on purpose. It collapses to nothing, Meta refuses a
     * blank parameter, and the server answers with the template and the slot in
     * the sentence — which the dialog shows verbatim. Inventing a stand-in in
     * the browser would send a customer a word nobody chose.
     */
    expect(templateParameterComponents(["   "])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "" }] },
    ]);
  });

  it("sends no block at all for a template with no variables", () => {
    // An empty parameter list is refused by Meta as firmly as a missing one, so
    // the correct block for a template that takes nothing is no block.
    expect(templateParameterComponents([])).toBeUndefined();
  });

  it("shapes however many values it is handed, since the slot count is the server's to check", () => {
    // Too many and too few both reach the one place that holds the template's
    // real slot count. Guessing here would mean two answers to the same
    // question, and the browser's would be the one made of stale cache.
    expect(templateParameterComponents(["a", "b", "c"])?.[0]).toMatchObject({
      parameters: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "text", text: "c" },
      ],
    });
  });
});

describe("flattening one value", () => {
  it("handles nothing at all without producing the string 'undefined'", () => {
    expect(flattenTemplateParameter(undefined)).toBe("");
    expect(flattenTemplateParameter(null)).toBe("");
  });

  it("trims the edges and collapses the middle", () => {
    expect(flattenTemplateParameter("  Sneha \n Chouksey  ")).toBe("Sneha Chouksey");
  });
});
