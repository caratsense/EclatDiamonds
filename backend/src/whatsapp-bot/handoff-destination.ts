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
  /** The first salesperson at the branch who can open Conversations. */
  salesperson: string | null;
}

/**
 * Who takes it.
 *
 * A person who already picked the thread up outranks everything — the
 * alternative is the bot reassigning a thread out from under somebody
 * mid-reply. After that the script's own nominee, which is more specific than
 * "the first manager at that branch", which is the last resort.
 *
 * Except that a manager is no longer the LAST resort. The Bandra bridal ad
 * went to nobody because the one person at that branch was a salesperson, and
 * "no manager here" is not a reason to leave a customer with nobody — the
 * client's own words: everybody assigned to that store, salesperson, store
 * manager, anybody. So a salesperson there takes it when no manager can.
 *
 * Null is still a real answer: when the ad matched no script with a branch
 * there is nobody this can honestly name, and inventing one sends a customer's
 * enquiry to people who never ran that ad.
 */
export function chooseHandoffOwner(c: HandoffCandidates): string | null {
  return c.holder ?? c.named ?? c.manager ?? c.salesperson ?? null;
}

/**
 * Which branch it lands at: the one it already has, else the one the script
 * for this ad names. Never a third choice — see above.
 */
export function chooseHandoffStore(onThread: string | null, fromRule: string | null): string | null {
  return onThread ?? fromRule;
}

/**
 * Who hears about it.
 *
 * This used to be one person, with the argument that a notification sent to
 * everybody is one nobody treats as theirs. The client overruled it from the
 * shop floor: the Bandra ad's enquiries reached no one at all, and she would
 * rather five people see a lead than nobody. So the whole branch is told.
 *
 * The owner is still ONE person — telling a branch is not the same as making
 * a thread everybody's job — and goes first, which is the order the bell text
 * is written for: "waiting for a person", and then who has it.
 *
 * Deduplicated, because the owner is normally one of the branch's own staff
 * and two rows for the same lead on one person's bell is just noise.
 */
export function handoffAudience(owner: string | null, branch: string[]): string[] {
  return [...new Set([...(owner ? [owner] : []), ...branch])];
}
