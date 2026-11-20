import type { UserAccess } from "@/lib/queries/access";
import { ROLE_LABELS } from "@/lib/types";

/**
 * The two sentences on People & Access that depend on where sales staff start.
 * Kept out of the page so they can be checked without rendering it.
 */

/** "a" or "an", so the sentence does not read "a area manager". */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * Where this person's starting point comes from.
 *
 * A role head office created IS the role. It is not "an area manager with
 * changes": they named it, they chose its screens, and the product calling it
 * something else — anywhere a person reads it as an identity — is the product
 * contradicting them.
 *
 * The built-in it was created from still decides reach and approval level, and
 * that is real. It belongs where that choice is MADE, in Manage roles, phrased
 * as what it governs. It does not belong in a sentence about who somebody is.
 */
export function startingPointLine(
  person: Pick<UserAccess, "name" | "role" | "startsAttendanceOnly"> & {
    customRoleName?: string | null;
  },
): string {
  if (person.startsAttendanceOnly) {
    return "Sales staff in this workspace start with attendance only. Switch on what this person needs.";
  }
  const base = ROLE_LABELS[person.role].toLowerCase();
  const from = person.customRoleName ?? `${article(base)} ${base}`;
  return `Starts from what ${from} gets. Changes apply to ${person.name} only.`;
}

/**
 * The question before "All sales staff: attendance only".
 *
 * Where sales staff already start with attendance only, the button can only
 * take away what head office switched on for some of them, and "Role defaults"
 * leaves a person on attendance only, so it is not offered as the undo.
 */
export function bulkAttendanceOnlyPrompt(count: number, alreadyTheStart: boolean): string {
  return `Set all ${count} sales staff to attendance only?

${
  alreadyTheStart
    ? "Sales staff in this workspace already start with attendance only, so this only takes away the screens that were switched on for some of them. To give a screen back, switch it on for that person again."
    : 'After signing in they will see Check in / Check out and nothing else. Undo it for any one person with "Role defaults".'
}`;
}
