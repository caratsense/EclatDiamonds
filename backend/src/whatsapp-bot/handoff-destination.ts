/**
 * Where a conversation goes when the bot script runs out.
 *
 * The client watched a thread finish its script and sit at "No store yet ·
 * Unassigned", with the reassign dialog offering "No location (central queue)"
 * and "Nobody". Her instruction: after the last message of the script it
 * should go to the branch that ad ran for, or to whoever that script names.
 *
 * Two things were missing. A thread only ever took its branch at the FIRST
 * message, so a script given its branch afterwards never passed it on; and the
 * handoff looked for a manager only when the thread already had a branch, so a
 * thread without one was handed to nobody.
 *
 * Pure, and separate from the service, because the ORDER is the part that is
 * easy to get subtly wrong and worth being able to read on its own.
 */

export interface HandoffCandidates {
  /** Whoever already holds the thread, if they can still open Conversations. */
  holder: string | null;
  /** The person this script nominates, if they can open Conversations. */
  named: string | null;
  /** The first manager at the branch who can open Conversations. */
  manager: string | null;
}

/**
 * Who takes it.
 *
 * A person who already picked the thread up outranks everything — the
 * alternative is the bot reassigning a thread out from under somebody
 * mid-reply. After that the script's own nominee, which is more specific than
 * "the first manager at that branch", which is the last resort.
 *
 * Null is a real answer: when the ad matched no script with a branch there is
 * nobody this can honestly name, and inventing one sends a customer's enquiry
 * to people who never ran that ad.
 */
export function chooseHandoffOwner(c: HandoffCandidates): string | null {
  return c.holder ?? c.named ?? c.manager ?? null;
}

/**
 * Which branch it lands at: the one it already has, else the one the script
 * for this ad names. Never a third choice — see above.
 */
export function chooseHandoffStore(onThread: string | null, fromRule: string | null): string | null {
  return onThread ?? fromRule;
}
