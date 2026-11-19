/**
 * A follow-up's reminder as the API sends it: the instant, the same moment in
 * the BRANCH's own time, and whether it has gone out.
 */
export interface ReminderView {
  at: string;
  /** "YYYY-MM-DDTHH:MM" at the branch — shown as-is, never re-zoned by the browser. */
  local: string;
  state: "scheduled" | "sent";
  sentAt: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Oct, 18:00" from a branch-local "YYYY-MM-DDTHH:MM". */
export function formatLocalReminder(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(local);
  if (!m) return local;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}, ${m[4]}`;
}

/** "Reminder 1 Oct, 18:00" / "Reminded 1 Oct, 18:00", or null when there is none. */
export function reminderLabel(r: ReminderView | null | undefined): string | null {
  if (!r) return null;
  return `${r.state === "sent" ? "Reminded" : "Reminder"} ${formatLocalReminder(r.local)}`;
}

/**
 * What happens to the REST of the schedule when a follow-up is marked done.
 *
 * Three separate answers, because the client asked for three (Nov): the
 * remaining reminders stand, or they stop because everything is sorted, or the
 * customer asked to be called next month instead. Completing a follow-up is
 * never on its own a reason to stop the next one, so "keep" is the default.
 */
export type FollowUpNextStep = "keep" | "stop" | "reschedule";

export interface FollowUpDoneDraft {
  remark: string;
  next: FollowUpNextStep;
  /** yyyy-mm-dd; read only when `next` is "reschedule". */
  nextDueDate: string;
}

/** The body of PATCH /leads/reminders/:id when a follow-up is marked done. */
export interface FollowUpDoneBody {
  done: true;
  note: string;
  stopReminders?: true;
  nextDueDate?: string;
}

/**
 * At least one letter or digit, in any script — remarks are written in Hindi as
 * often as in English, and "Paid 20000" is a remark while "..." is not. Mirrors
 * the backend's `hasMeaningfulRemark`, which refuses the save either way; this
 * is only so the counter is told before pressing the button.
 */
const MEANINGFUL = /[\p{L}\p{N}]/u;

/** The field to put right before this follow-up can be saved, and why. */
export interface FollowUpDoneProblem {
  field: "remark" | "nextDueDate";
  message: string;
}

/** What stops this follow-up being saved, or null when nothing does. */
export function followUpDoneProblem(draft: FollowUpDoneDraft): FollowUpDoneProblem | null {
  if (!MEANINGFUL.test(draft.remark)) {
    return { field: "remark", message: "Add a remark — what happened on this follow-up?" };
  }
  if (draft.next === "reschedule" && !draft.nextDueDate) {
    return { field: "nextDueDate", message: "Pick the date of the next follow-up." };
  }
  return null;
}

/** The request that follow-up draft becomes. Call only once it has no problem. */
export function followUpDoneBody(draft: FollowUpDoneDraft): FollowUpDoneBody {
  const note = draft.remark.trim();
  if (draft.next === "stop") return { done: true, note, stopReminders: true };
  if (draft.next === "reschedule") return { done: true, note, nextDueDate: draft.nextDueDate };
  return { done: true, note };
}
