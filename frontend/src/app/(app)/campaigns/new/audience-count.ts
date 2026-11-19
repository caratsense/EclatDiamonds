import type { AudiencePreview, SegmentDefinition } from "@/lib/queries/campaigns";

/**
 * Whether the count on screen is this broadcast's count, and whether it may be
 * sent for approval.
 *
 * The client reached Review without ever pressing "Count who this reaches",
 * read "Audience: Not counted yet", and still had a live "Send for approval"
 * button — a release to an unknown number of customers. The count is the one
 * number the screen exists to show, so everything about it is decided here, in
 * one place the wizard cannot forget to ask.
 */

/** A count, and the audience it was counted for. */
export interface AudienceCount {
  key: string;
  preview: AudiencePreview;
}

export interface AudienceGate {
  /** The count that belongs to the rules on screen now, or null. */
  preview: AudiencePreview | null;
  /** A count exists, but it was run for rules that have since been edited. */
  stale: boolean;
  /** Review's one-line answer to "who does this reach". */
  summary: string;
  /** Why the broadcast cannot go for approval yet, or null when it can. */
  blocker: string | null;
}

/**
 * Which audience a count was run for.
 *
 * A count is a database aggregate taken at one moment against one set of
 * rules, and it stops describing this campaign the instant a rule or a branch
 * changes. Comparing the key the count was run for against the key of the
 * rules on screen now is what keeps a number counted before an edit from being
 * presented as this campaign's audience — someone counts, steps back, swaps a
 * tag, returns, and the old number would otherwise still be sitting there
 * above a live send button.
 *
 * Deliberately a dumb serialisation rather than a clever comparison: reordering
 * two rules that mean the same thing costs one recount, and a recount is never
 * the expensive mistake here.
 */
export function audienceKey(definition: SegmentDefinition, storeIds: string[]): string {
  return JSON.stringify({
    match: definition.match,
    conditions: definition.conditions.map((c) => [c.field, c.op, c.value ?? null]),
    // Branches narrow the audience as much as any rule does. Sorted because
    // the order the branch buttons were pressed in is not part of it.
    storeIds: [...storeIds].sort(),
  });
}

export function audienceGate(at: {
  counted: AudienceCount | null;
  /** The key of the rules and branches on screen now. */
  key: string;
  /** A count is in flight. */
  counting: boolean;
}): AudienceGate {
  const current = at.counted && at.counted.key === at.key ? at.counted.preview : null;
  const stale = Boolean(at.counted) && !current;

  if (current) {
    const summary = `${current.total.toLocaleString()} match, ${current.contactable.toLocaleString()} contactable`;
    return { preview: current, stale: false, summary, blocker: blockerFor(current) };
  }

  if (at.counting) {
    return {
      preview: null,
      stale,
      summary: "Counting…",
      blocker: "Counting who this reaches. The broadcast can go for approval once that number is in.",
    };
  }

  return {
    preview: null,
    stale,
    summary: stale ? "The rules changed — counting again" : "Not counted yet",
    blocker: stale
      ? "The rules changed since the last count. Count who this reaches again before sending it for approval."
      : "Count who this reaches before sending it for approval.",
  };
}

/**
 * A count of nobody blocks the send too.
 *
 * Sending to nobody is a mistake somebody made in the rules, not a send: it
 * spends an approval, finishes as a completed broadcast that reached no one,
 * and tells the manager nothing about what went wrong. Saying which of the two
 * numbers is zero is the difference between a refusal she can act on and a
 * dead end.
 */
function blockerFor(preview: AudiencePreview): string | null {
  if (preview.total === 0) {
    return "These rules match nobody. Change them so the broadcast has someone to reach.";
  }
  if (preview.contactable === 0) {
    return `None of the ${preview.total.toLocaleString()} people who match have a phone or WhatsApp number, so nothing could be sent.`;
  }
  return null;
}
