import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CLOSED,
  SearchSelect,
  boxStep,
  boxView,
  matchOptions,
  resolveOption,
  type BoxEvent,
  type SearchOption,
} from "./search-select";

/**
 * A quote's item type and metal are picked by typing, the way the shop's ERP
 * does it. What the list narrows to, what counts as an option typed in full,
 * and what a key, a click or a pick does to the box are decided by pure
 * functions, so they are tested as such: the box in use is driven here one
 * event at a time, the way the screen drives it. The box itself is rendered
 * once, closed, for what the screen and the browser tests read from it; a
 * server render needs no DOM for that.
 */

/** The shop's item types, in the order the server sends them: by code. */
const TYPES: SearchOption[] = [
  ["AANK", "ANKLET"], ["ABG", "BANGLE"], ["ABR", "BRACELET"], ["ACH", "CHAIN"], ["AER", "EARRING"],
  ["AGR", "GENTS RINGS"], ["ALR", "LADIES RING"], ["ANK", "NECKLACE"], ["ANP", "NOSEPIN"], ["APD", "PENDANT"],
].map(([code, name]) => ({ code, name }));

/** Gold as the ERP codes it, G<karat><tone>, with the karat and colour the builder also finds it by. */
const METALS: SearchOption[] = [9, 12, 14, 18].flatMap((karat) =>
  ["PG", "WG", "YG"].map((tone) => ({
    code: `G${String(karat).padStart(2, "0")}${tone}`,
    name: `GOLD${karat}${tone}`,
    keywords: `${karat}K ${tone}`,
  })),
);

const codes = (options: SearchOption[], text: string) => matchOptions(options, text).map((o) => o.code);

describe("narrowing the list", () => {
  it("offers everything until something is typed", () => {
    expect(matchOptions(TYPES, "")).toEqual(TYPES);
    expect(matchOptions(TYPES, "  ")).toEqual(TYPES);
  });

  it("narrows by a part of the name, in any case", () => {
    expect(codes(TYPES, "Pend")).toEqual(["APD"]);
    expect(codes(TYPES, "LACE")).toEqual(["ANK"]);
  });

  it("narrows by a part of the code", () => {
    expect(codes(TYPES, "ALR")).toEqual(["ALR"]);
    expect(codes(TYPES, "ab")).toEqual(["ABG", "ABR"]);
    expect(codes(METALS, "14")).toEqual(["G14PG", "G14WG", "G14YG"]);
    expect(codes(METALS, "wg")).toEqual(["G09WG", "G12WG", "G14WG", "G18WG"]);
  });

  it("puts a code typed in full first, so Enter takes it", () => {
    // ANK is the necklace. The anklet has the same letters and sorts above it.
    expect(codes(TYPES, "ank")).toEqual(["ANK", "AANK"]);
  });

  it("puts what the text begins before what only has it inside a word", () => {
    // A ring before an earring, though the server lists the earring first.
    expect(codes(TYPES, "ring")).toEqual(["AGR", "ALR", "AER"]);
    // It begins ANKLET and the codes ANK and ANP; BANGLE and PENDANT only have it.
    expect(codes(TYPES, "an")).toEqual(["AANK", "ANK", "ANP", "ABG", "APD"]);
    expect(codes(TYPES, "gents r")).toEqual(["AGR"]);
  });

  it("finds an option by its keywords, which the list does not show", () => {
    // The karat as the screen itself writes it: "18K · today's rate".
    expect(codes(METALS, "18K")).toEqual(["G18PG", "G18WG", "G18YG"]);
    expect(codes(METALS, "14k wg")).toEqual(["G14WG"]);
  });

  it("offers nothing for what is in no code, name or keyword", () => {
    expect(codes(TYPES, "watch")).toEqual([]);
    expect(codes(METALS, "22")).toEqual([]);
    expect(codes(METALS, "22K")).toEqual([]);
  });
});

describe("an option typed in full", () => {
  it("is its code, in any case and with spaces around it", () => {
    expect(resolveOption(METALS, "G14YG")?.code).toBe("G14YG");
    expect(resolveOption(TYPES, " alr ")?.code).toBe("ALR");
  });

  it("is also its name, or its code and name as the box shows them", () => {
    expect(resolveOption(TYPES, "pendant")?.code).toBe("APD");
    expect(resolveOption(TYPES, "ALR LADIES RING")?.code).toBe("ALR");
  });

  it("is never a part of one, however few options it leaves", () => {
    expect(resolveOption(TYPES, "pend")).toBeUndefined();
    expect(resolveOption(METALS, "G22YG")).toBeUndefined();
    expect(resolveOption(TYPES, "")).toBeUndefined();
  });

  it("is not a keyword: that finds an option, it does not name one", () => {
    expect(resolveOption(METALS, "18K YG")).toBeUndefined();
  });

  it("is not a name two options share: the list offers both, to be picked", () => {
    // The shop's master calls its two-tone G18W/YG "GOLD18YG", the same as G18YG.
    const twins = [{ code: "G18W/YG", name: "GOLD18YG" }, { code: "G18YG", name: "GOLD18YG" }];
    expect(resolveOption(twins, "gold18yg")).toBeUndefined();
    expect(codes(twins, "gold18yg")).toEqual(["G18W/YG", "G18YG"]);
    expect(resolveOption(twins, "g18yg")?.code).toBe("G18YG");
    expect(resolveOption(twins, "G18YG GOLD18YG")?.code).toBe("G18YG");
  });
});

/**
 * The box in use, without a browser. Each event goes through `boxStep`, and a
 * code it hands back becomes the value, as it does on the screen.
 */
function drive(options: SearchOption[], value = "") {
  let state = CLOSED;
  const changes: string[] = [];
  const box = {
    /** Every code the box's owner was given, in order. */
    changes,
    send(...events: BoxEvent[]) {
      for (const event of events) {
        const next = boxStep(state, event, options, value);
        state = next.state;
        if (next.change !== undefined) {
          value = next.change;
          changes.push(next.change);
        }
      }
      return box;
    },
    /** A design loaded from outside sets the value itself. */
    load(code: string) {
      value = code;
      return box;
    },
    get value() {
      return value;
    },
    get open() {
      return state.open;
    },
    get view() {
      return boxView(state, options, value);
    },
    /** The row Enter would take. */
    get highlighted() {
      return boxView(state, options, value).matches[state.active]?.code;
    },
  };
  return box;
}

const typing = (text: string): BoxEvent => ({ type: "input", text });
const press = (key: string): BoxEvent => ({ type: "key", key });
const click: BoxEvent = { type: "click" };
const leave: BoxEvent = { type: "blur" };
const pick = (code: string): BoxEvent => ({ type: "pick", option: TYPES.find((o) => o.code === code)! });

describe("the box in use", () => {
  it("opens on a click, on the down arrow and on typing, with the whole list until something is typed", () => {
    expect(drive(TYPES).open).toBe(false);
    expect(drive(TYPES).send(click).open).toBe(true);
    expect(drive(TYPES).send(click).view.matches).toEqual(TYPES);
    expect(drive(TYPES).send(press("ArrowDown")).open).toBe(true);
    expect(drive(TYPES).send(typing("r")).open).toBe(true);
  });

  it("moves the highlight with the arrows, and stops at either end", () => {
    const box = drive(TYPES).send(typing("ring"));
    expect(box.highlighted).toBe("AGR");
    expect(box.send(press("ArrowDown")).highlighted).toBe("ALR");
    expect(box.send(press("ArrowDown"), press("ArrowDown")).highlighted).toBe("AER");
    expect(box.send(press("ArrowUp"), press("ArrowUp"), press("ArrowUp")).highlighted).toBe("AGR");
  });

  it("gives its owner the highlighted option on Enter, and closes", () => {
    const box = drive(TYPES).send(typing("ring"), press("ArrowDown"), press("Enter"));
    // Typing un-chose whatever was there; Enter chose the ladies' ring.
    expect(box.changes).toEqual(["", "ALR"]);
    expect(box.open).toBe(false);
    expect(box.view.shown).toBe("ALR LADIES RING");
    expect(box.view.invalid).toBe(false);
  });

  it("gives its owner a clicked option, and closes", () => {
    const box = drive(TYPES).send(click, pick("APD"));
    expect(box.changes).toEqual(["APD"]);
    expect(box.open).toBe(false);
    expect(box.view.shown).toBe("APD PENDANT");
  });

  it("opens on the chosen option, so Enter straight away changes nothing", () => {
    const box = drive(TYPES, "ANK").send(click);
    expect(box.highlighted).toBe("ANK");
    expect(box.send(press("Enter")).changes).toEqual([]);
    expect(box.send(click, pick("ANK")).changes).toEqual([]);
    expect(box.value).toBe("ANK");
  });

  it("un-chooses as soon as something else is typed over the choice", () => {
    const box = drive(TYPES, "ALR").send(typing("p"));
    expect(box.changes).toEqual([""]);
    expect(box.view.matches.map((o) => o.code)).toEqual(["APD", "ANP"]);
  });

  it("closes on Escape and on leaving, with what was typed and not picked kept and marked", () => {
    for (const close of [press("Escape"), leave]) {
      const box = drive(TYPES).send(typing("pen"));
      // Still a search: the pendant is offered.
      expect(box.view.invalid).toBe(false);
      box.send(close);
      expect(box.open).toBe(false);
      expect(box.view.shown).toBe("pen");
      expect(box.view.invalid).toBe(true);
      expect(box.value).toBe("");
    }
  });

  it("is marked at once when nothing matches", () => {
    const box = drive(TYPES).send(typing("watch"));
    expect(box.view.matches).toEqual([]);
    expect(box.view.invalid).toBe(true);
    expect(box.value).toBe("");
  });

  it("takes a code typed in full without Enter, and shows it as a picked one once left", () => {
    const box = drive(TYPES).send(typing("alr"));
    expect(box.value).toBe("ALR");
    expect(box.view.shown).toBe("alr");
    expect(box.send(leave).view.shown).toBe("ALR LADIES RING");
  });

  it("drops what was typed once the value is set from outside", () => {
    const box = drive(TYPES).send(typing("zzz"), leave).load("AANK");
    expect(box.view.shown).toBe("AANK ANKLET");
    expect(box.view.invalid).toBe(false);
    expect(box.send(click).view.matches).toEqual(TYPES);
  });

  it("does nothing with Enter when there is no row to take, or with a key that is not the list's", () => {
    expect(boxStep(CLOSED, press("Enter"), TYPES, "")).toEqual({ state: CLOSED });
    expect(boxStep(CLOSED, press("Tab"), TYPES, "ALR")).toEqual({ state: CLOSED });
    const box = drive(TYPES).send(typing("watch"), press("Enter"));
    expect(box.changes).toEqual([""]);
    expect(box.open).toBe(true);
  });
});

describe("the box", () => {
  /** The box's own <input>, as the server renders it for a given value. */
  const box = (value: string) =>
    renderToStaticMarkup(
      createElement(SearchSelect, { options: TYPES, value, onChange: () => {}, "aria-label": "Item 1 type" }),
    ).match(/<input[^>]*>/)?.[0] ?? "";

  it("shows the chosen option as its code and name", () => {
    expect(box("ALR")).toContain('value="ALR LADIES RING"');
    expect(box("ALR")).toContain('aria-invalid="false"');
  });

  it("keeps a value that is not an option in view, marked invalid", () => {
    expect(box("WATCH")).toContain('value="WATCH"');
    expect(box("WATCH")).toContain('aria-invalid="true"');
  });

  it("is not invalid for being empty", () => {
    expect(box("")).toContain('value=""');
    expect(box("")).toContain('aria-invalid="false"');
  });

  it("is found by the name it is given, as a combobox", () => {
    expect(box("")).toContain('aria-label="Item 1 type"');
    expect(box("")).toContain('role="combobox"');
  });
});
