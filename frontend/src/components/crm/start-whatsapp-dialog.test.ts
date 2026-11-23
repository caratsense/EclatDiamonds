import { describe, expect, it } from "vitest";

import { branchChoices, sendOutcomeNote } from "@/components/crm/start-whatsapp-dialog";
import { mergeTagIds } from "@/lib/queries/crm";

/**
 * The three decisions behind "starting a conversation needs more than a phone
 * number" (client, 23 Nov: "no name field … no selector for which store they
 * are of … no field to add a tag").
 *
 * All three fail SILENTLY if they are wrong, which is why they are tested here
 * rather than left to the screen: a branch list that offers somebody else's
 * shop is refused by the server with a message nobody expects, a tag write that
 * replaces instead of adds deletes a colleague's work with no trace, and a
 * toast that reports the wrong case teaches the sender that naming a customer
 * renames them.
 */

const SURAT = { id: "st_surat", name: "Surat — Main" };
const BORIVALI = { id: "st_borivali", name: "Mumbai — Borivali" };
const ALL = { id: "st_all", name: "All Stores", isAggregate: true };

describe("which branches a customer may be filed at", () => {
  it("offers only the branches this person holds", () => {
    const { options } = branchChoices([SURAT, BORIVALI], SURAT);
    expect(options.map((o) => o.id)).toEqual(["st_surat", "st_borivali"]);
  });

  /*
   * "All Stores" is a way of LOOKING at every branch, not a place a customer
   * lives. Offering it would send the aggregate's id to `assertTradingStore`,
   * which refuses it — a branch picker whose default choice cannot be used.
   */
  it("never offers the All Stores aggregate as a home branch", () => {
    const { options } = branchChoices([SURAT, ALL], SURAT);
    expect(options.map((o) => o.id)).toEqual(["st_surat"]);
  });

  it("opens on the branch in the top bar, because that is almost always right", () => {
    expect(branchChoices([SURAT, BORIVALI], BORIVALI).initial).toBe("st_borivali");
  });

  /*
   * On the aggregate there is no single branch to mean, and head office picking
   * one of them would file the customer at a shop that has never met them. No
   * branch is a real answer: the thread waits in the central queue.
   */
  it("opens on no branch when the top bar is on All Stores", () => {
    expect(branchChoices([SURAT, BORIVALI, ALL], ALL).initial).toBe("none");
  });

  /*
   * The store switcher is restored from storage, so it can still be pointed at
   * a branch this person has since lost. Defaulting to it would ask the server
   * to file a customer outside the caller's scope, which `assertStore` refuses.
   */
  it("falls back to no branch when the top bar is outside this person's scope", () => {
    expect(branchChoices([SURAT], BORIVALI).initial).toBe("none");
  });
});

describe("applying tags to a customer who may already have some", () => {
  it("adds without removing what a colleague recorded", () => {
    expect(mergeTagIds(["bridal"], ["vip"])).toEqual(["bridal", "vip"]);
  });

  it("applying a tag the customer already carries changes nothing", () => {
    expect(mergeTagIds(["bridal", "vip"], ["vip"])).toEqual(["bridal", "vip"]);
  });

  it("keeps the chips in the order the customer earned them", () => {
    expect(mergeTagIds(["bridal"], ["vip", "vip", "walk-in"])).toEqual([
      "bridal",
      "vip",
      "walk-in",
    ]);
  });

  it("writes exactly the picked set for a customer created a moment ago", () => {
    expect(mergeTagIds([], ["vip"])).toEqual(["vip"]);
  });
});

describe("what the sender is told happened", () => {
  it("says a new customer was created", () => {
    expect(sendOutcomeNote({ outcome: "created", partyId: "p1", contactPointId: "c1" }, undefined))
      .toBe("Saved as a new customer.");
  });

  /*
   * The outcome somebody who just typed a name would otherwise misread. Naming
   * an existing customer does NOT rename them, so the thread opens under what
   * a colleague recorded and the sender has to know that before they wonder
   * why their spelling did not take.
   */
  it("says an existing customer was left alone", () => {
    const note = sendOutcomeNote(
      { outcome: "matched", partyId: "p1", contactPointId: "c1" },
      undefined,
    );
    expect(note).toContain("already a customer");
    expect(note).toContain("left as it is");
  });

  it("names the tags that were actually added", () => {
    expect(
      sendOutcomeNote({ outcome: "created", partyId: "p1", contactPointId: "c1" }, {
        added: ["VIP", "Bridal"],
      }),
    ).toBe("Saved as a new customer. Tagged VIP, Bridal.");
  });

  /*
   * The message went and the tags did not — the half that can still be fixed
   * from the customer screen. Reporting it as a success with no mention would
   * leave somebody believing a customer is labelled when they are not.
   */
  it("admits when the tags did not stick", () => {
    const note = sendOutcomeNote({ outcome: "matched", partyId: "p1", contactPointId: "c1" }, {
      added: [],
      failed: "Customer not found",
    });
    expect(note).toContain("tags were not applied");
  });

  it("says nothing when no record was touched", () => {
    expect(sendOutcomeNote(undefined, undefined)).toBeUndefined();
  });

  it("passes on why a number could not be matched to anybody", () => {
    expect(
      sendOutcomeNote(
        {
          outcome: "unresolved",
          partyId: null,
          contactPointId: null,
          reason: '"12" is not a usable whatsapp.',
        },
        undefined,
      ),
    ).toBe('"12" is not a usable whatsapp.');
  });
});
