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
