import type { SegmentDefinition } from './audience-segment.dsl';
import type { RecipientStatus } from './campaign-delivery';

/**
 * "These many people have already received this template, do you want to send
 * again? If no, exclude them."
 *
 * The client's own sentence, and the half that matters is "exclude them": the
 * answer has to change who is messaged, not just what the screen said before
 * the send. So the decision travels with the frozen audience and is read again
 * by expansion, which is the only place that decides who gets a recipient row.
 */

/**
 * Having been MESSAGED, not merely targeted.
 *
 * A broadcast that failed for somebody has not given them the message, and
 * suppressing them from the next one would quietly guarantee they never get it.
 * These three statuses are the ones the recipient screen groups as "Got it".
 */
export const REACHED_STATUSES: RecipientStatus[] = ['sent', 'delivered', 'read'];

/**
 * Why somebody on a broadcast's list was left out by this rule. Stored as a
 * code like every other exclusion reason, so changing the wording later does
 * not rewrite history.
 */
export const ALREADY_RECEIVED_REASON = 'already_received_template';

/**
 * Where the decision lives inside `audienceSnapshot`.
 *
 * Beside the rules rather than in a column of its own, because it IS part of
 * the audience the approver signed off on and has to be frozen at the same
 * moment by the same write. `parseSegmentDefinition` reads only `match` and
 * `conditions`, so an extra key here is carried without being understood — the
 * definition round-trips unchanged and nothing else in the DSL has to learn
 * about suppression.
 */
const SUPPRESS_KEY = 'suppressTemplateAlreadySent';

/** The audience snapshot to store: the rules, plus the suppression if any. */
export function audienceSnapshotWith(
  definition: SegmentDefinition | null,
  suppressTemplateName: string | null,
): Record<string, unknown> {
  return {
    ...(definition ?? {}),
    ...(suppressTemplateName ? { [SUPPRESS_KEY]: suppressTemplateName } : {}),
  };
}

/**
 * The template whose previous recipients this campaign leaves out, or null.
 *
 * Reads a plain non-empty string and nothing else: the snapshot is a Json
 * column that has held three shapes over the product's life, and a malformed
 * value here must mean "no suppression" rather than stopping an expansion.
 */
export function suppressedTemplateFrom(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[SUPPRESS_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
