import { describe, expect, it } from "vitest";

import {
  pickOf,
  savedTemplateState,
  templateOptionKey,
  templateUnsendableReason,
} from "@/components/campaigns/template-picker";
import { fillTemplateBody } from "@/components/crm/send-template-dialog";
import {
  isTemplateSendable,
  TEMPLATE_VERDICT_MAX_AGE_MS,
  type MessageTemplateRow,
} from "@/lib/queries/meta-admin";

/**
 * What the compact picker says about a template that was SAVED and is no longer
 * offered.
 *
 * The dropdown lists only what `isTemplateSendable` allows, so a name Meta has
 * since paused matches no option and the control falls back to its placeholder.
 * Left there, Feedback Requests would read as a setting somebody forgot to fill
 * in — while the automation it configures quietly asks nobody. That is the one
 * state this screen must never be silent about, so it is decided here rather
 * than inside the markup.
 */

type RowOverrides = Partial<Omit<MessageTemplateRow, "metadata">> & {
  metadata?: Partial<MessageTemplateRow["metadata"]>;
};

/* Spread rather than `??` so a test can set `name: null` — an unnamed template
 * is a real row, and falling back over it would hide the case below. */
const row = ({ metadata, ...rest }: RowOverrides): MessageTemplateRow => ({
  id: "tpl_1",
  externalId: "ext_1",
  name: "visit_feedback",
  isActive: true,
  providerOwnershipVerified: true,
  lastVerifiedAt: new Date().toISOString(),
  lastError: null,
  integration: { id: "int_1", name: "Nibhana WhatsApp", providerCode: "meta", status: "connected" },
  ...rest,
  metadata: {
    channel: "whatsapp",
    languageCode: "en_US",
    category: "UTILITY",
    approvalStatus: "approved",
    providerStatus: "APPROVED",
    providerSyncedAt: new Date().toISOString(),
    variables: ["1", "2"],
    recordedAt: new Date().toISOString(),
    ...metadata,
  },
});

describe("identifying one option", () => {
  it("keys on the language as well as the name", () => {
    // The same template is approved per language and the send needs both
    // halves, so the two must never collapse onto one option.
    expect(templateOptionKey("order_update", "en_US")).not.toBe(
      templateOptionKey("order_update", "hi_IN"),
    );
  });
});

describe("the template this setting was saved with", () => {
  it("says nothing when no template is set", () => {
    // A blank first template is a real setting: a colleague asks in person.
    expect(savedTemplateState(null, [row({})]).kind).toBe("empty");
    expect(savedTemplateState({ name: "  ", languageCode: "en" }, [row({})]).kind).toBe("empty");
  });

  it("is quiet when the saved template is one of the offered ones", () => {
    const state = savedTemplateState({ name: "visit_feedback", languageCode: "en_US" }, [row({})]);
    expect(state.kind).toBe("offered");
  });

  it("names a template Meta has since paused", () => {
    const paused = [row({ metadata: { providerStatus: "PAUSED" } })];

    const state = savedTemplateState({ name: "visit_feedback", languageCode: "en_US" }, paused);

    expect(state).toEqual({ kind: "withdrawn", label: "visit_feedback (en_US)" });
  });

  it("names a template whose approval has gone stale", () => {
    // The verdict expires: Meta can pause a template at any moment and tells
    // us nothing, so a reading from two days ago authorises no send.
    const stale = [
      row({
        lastVerifiedAt: new Date(Date.now() - TEMPLATE_VERDICT_MAX_AGE_MS - 60_000).toISOString(),
      }),
    ];

    expect(savedTemplateState({ name: "visit_feedback", languageCode: "en_US" }, stale).kind).toBe(
      "withdrawn",
    );
  });

  it("treats the right name in the wrong language as withdrawn, not as approved", () => {
    // A legacy policy saved "en" against a template approved in "en_US". The
    // provider matches the code exactly, so this one sends nothing — and the
    // remedy is the same synchronise-and-look as a pause.
    const state = savedTemplateState({ name: "visit_feedback", languageCode: "en" }, [row({})]);

    expect(state).toEqual({ kind: "withdrawn", label: "visit_feedback (en)" });
  });

  it("separates a name nobody has on file, because that one has to be replaced", () => {
    const state = savedTemplateState({ name: "vist_feedbck", languageCode: "en" }, [row({})]);

    // The typo this picker exists to stop, saved before it existed. No
    // synchronise brings it back.
    expect(state).toEqual({ kind: "unrecognised", label: "vist_feedbck (en)" });
  });

  it("falls back to the provider's own id for a template with no name", () => {
    const unnamed = [row({ name: null, externalId: "1234567890" })];

    expect(savedTemplateState({ name: "1234567890", languageCode: "en_US" }, unnamed).kind).toBe(
      "offered",
    );
  });
});

/**
 * WHY A TEMPLATE ON FILE CANNOT GO OUT TODAY.
 *
 * 28 Nov: the client edited `newmessage` at Meta — which takes an approved
 * template back to PENDING for re-review — and then went to the thread to send
 * it. The pickers list only what `isTemplateSendable` allows and said nothing
 * about the rest, so the template she had just saved was simply not there, and
 * Meta's own sentence about it sat on a settings screen she had no reason to
 * open. The template is now listed, disabled, with that sentence beside it, and
 * the sentence is decided here rather than inside the markup.
 */
describe("why a template cannot be sent today", () => {
  it("says nothing about a template that can be sent", () => {
    // The mirror of the verdict, never a second opinion on it: a template the
    // server would accept must not pick up a reason it cannot go.
    expect(templateUnsendableReason(row({}))).toBeNull();
  });

  it("gives Meta's own sentence for the template the client had just edited", () => {
    const edited = row({
      name: "newmessage",
      providerOwnershipVerified: false,
      lastError: "Edited at Meta; awaiting review. Provider reports PENDING.",
      metadata: { providerStatus: "PENDING", category: "marketing" },
    });

    // Not our paraphrase. The edit endpoint wrote this sentence because it is
    // the one fact that explains where her template went.
    expect(templateUnsendableReason(edited)).toBe(
      "Edited at Meta; awaiting review. Provider reports PENDING.",
    );
  });

  it("names the provider's verdict when nothing recorded a sentence", () => {
    // Rows synchronised before `lastError` was written, and anything Meta
    // refused without explaining. "pending", not "PENDING": it is read in a
    // sentence, not in a log.
    for (const [status, said] of [
      ["PENDING", "Meta reports this template as pending."],
      ["REJECTED", "Meta reports this template as rejected."],
      ["PAUSED", "Meta reports this template as paused."],
      ["DISABLED", "Meta reports this template as disabled."],
      ["PENDING_DELETION", "Meta reports this template as pending deletion."],
      ["UNKNOWN", "Meta reports this template as unknown."],
    ] as const) {
      expect(templateUnsendableReason(row({ metadata: { providerStatus: status } }))).toBe(said);
    }
  });

  it("says a template switched off here is switched off here, not refused by Meta", () => {
    // Approved by Meta and turned off on our side are different problems with
    // different remedies, and the remedy for this one is not a synchronise.
    expect(templateUnsendableReason(row({ isActive: false }))).toBe(
      "Switched off for this connection.",
    );
  });

  it("separates a template Meta has never been asked about from one it has paused", () => {
    expect(templateUnsendableReason(row({ lastVerifiedAt: null }))).toBe(
      "Never confirmed with Meta. Synchronise templates to check it.",
    );
  });

  it("explains a verdict that has simply gone out of date", () => {
    // Approved, active, and last confirmed two days ago. Meta pauses templates
    // for quality without telling anyone, so this one is not refused — it is
    // unconfirmed, and the sentence has to say so or it reads as a rejection.
    const stale = row({
      lastVerifiedAt: new Date(Date.now() - TEMPLATE_VERDICT_MAX_AGE_MS - 60_000).toISOString(),
    });

    expect(templateUnsendableReason(stale)).toBe(
      "Meta's approval for this is more than a day old. Synchronise templates to confirm it.",
    );
  });

  it("keeps offering an approved template whose ownership flag was never raised", () => {
    /*
     * The one case where failing closed would be the bug. The server's gate is
     * `templateSendability(isActive, providerStatus, lastVerifiedAt)` and does
     * not read `providerOwnershipVerified`, so refusing one here would lock a
     * manager out of a template Meta would have accepted — the shared verdict
     * exists to agree with the server in BOTH directions, not to be stricter.
     */
    const row_ = row({ providerOwnershipVerified: false, lastError: "stale note from last week" });

    expect(isTemplateSendable(row_)).toBe(true);
    expect(templateUnsendableReason(row_)).toBeNull();
  });

  it("holds a carousel on the same rule as any other template", () => {
    // A carousel is a different template shape, not a different approval:
    // approved it sends, pending it waits, and the reason reads the same.
    expect(templateUnsendableReason(row({ metadata: { isCarousel: true } }))).toBeNull();
    expect(
      templateUnsendableReason(
        row({ metadata: { isCarousel: true, providerStatus: "REJECTED" } }),
      ),
    ).toBe("Meta reports this template as rejected.");
  });
});

/**
 * WHAT THE SENDER READS IS WHAT THE CUSTOMER GETS.
 *
 * `bodySource` carries the wording with `{{1}}` intact; `bodyPreview` carries
 * the same wording with META'S SAMPLE VALUES already substituted. Filling the
 * second one would show a sender "Hello Priya" above a send going to Sneha —
 * which is the 28 Nov confusion read backwards, and just as reasonable a
 * mistake to make.
 */
describe("what the picker hands the send dialog", () => {
  const bodies = {
    bodySource: "Hello {{1}}, hope you are having a good day!",
    bodyPreview: "Hello Priya, hope you are having a good day!",
  };

  it("substitutes into the wording as written, never into Meta's example", () => {
    const picked = pickOf(row({ name: "newmessage", metadata: { ...bodies, variables: ["{{1}}"] } }));

    expect(picked.source).toBe(bodies.bodySource);
    expect(fillTemplateBody(picked.source, ["Sneha"])).toBe(
      "Hello Sneha, hope you are having a good day!",
    );
    // The sample name must not survive anywhere near the finished sentence.
    expect(fillTemplateBody(picked.source, ["Sneha"])).not.toContain("Priya");
  });

  it("carries one slot for one variable, and the default that fills it", () => {
    const picked = pickOf(
      row({
        metadata: {
          ...bodies,
          variables: ["{{1}}"],
          variableDefaults: [{ slot: 1, source: "customer_first_name", fallback: "there" }],
        },
      }),
    );

    expect(picked.variableCount).toBe(1);
    expect(picked.variableDefaults).toEqual([
      { slot: 1, source: "customer_first_name", fallback: "there" },
    ]);
  });

  it("asks for nothing on a template that takes nothing", () => {
    // No `{{n}}` means no inputs and no empty-slot warning; the wording is the
    // whole of it.
    const picked = pickOf(
      row({ metadata: { bodySource: "Thank you for visiting.", variables: [] } }),
    );

    expect(picked.variableCount).toBe(0);
    expect(picked.variableDefaults).toEqual([]);
    expect(fillTemplateBody(picked.source, [])).toBe("Thank you for visiting.");
  });

  it("hands over no wording at all when only Meta's example was ever stored", () => {
    /*
     * Templates recorded before body source existed. `source` comes back empty
     * rather than falling back to the preview, which is what lets the dialog
     * say the finished sentence cannot be shown instead of showing one with
     * "Priya" in it.
     */
    const picked = pickOf(row({ metadata: { bodyPreview: bodies.bodyPreview, variables: ["{{1}}"] } }));

    expect(picked.source).toBe("");
    expect(picked.preview).toBe(bodies.bodyPreview);
  });
});
