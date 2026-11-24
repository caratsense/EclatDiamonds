import { describe, expect, it } from "vitest";

import {
  savedTemplateState,
  templateOptionKey,
} from "@/components/campaigns/template-picker";
import { TEMPLATE_VERDICT_MAX_AGE_MS, type MessageTemplateRow } from "@/lib/queries/meta-admin";

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
