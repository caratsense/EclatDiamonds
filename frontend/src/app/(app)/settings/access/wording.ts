import type { UserAccess } from "@/lib/queries/access";
import { ROLE_LABELS } from "@/lib/types";

/**
 * The two sentences on People & Access that depend on where sales staff start.
 * Kept out of the page so they can be checked without rendering it.
 */

/** Where this person's starting point comes from. */
export function startingPointLine(person: Pick<UserAccess, "name" | "role" | "startsAttendanceOnly">): string {
  return person.startsAttendanceOnly
    ? "Sales staff in this workspace start with attendance only. Switch on what this person needs."
    : `Starts from what a ${ROLE_LABELS[person.role].toLowerCase()} gets. Changes apply to ${person.name} only.`;
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
