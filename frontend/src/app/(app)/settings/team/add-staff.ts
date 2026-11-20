import type { CreateStaffInput, StaffUser } from "@/lib/queries/users";
import { normalizeIndianMobile } from "@/lib/utils";

/**
 * What Add staff sends, and what it tells the manager afterwards. Kept out of
 * the dialog so both are tested without a browser.
 */

/**
 * The request for what was typed into the form, which the dialog has already
 * checked. A blank password is left out rather than sent empty: the server
 * refuses an empty one, and without one it makes a random password nobody
 * knows.
 */
export function addStaffInput(
  form: Required<CreateStaffInput>,
): CreateStaffInput {
  return {
    name: form.name.trim(),
    storeId: form.storeId,
    phone: normalizeIndianMobile(form.phone) ?? undefined,
    email: form.email.trim(),
    role: form.role,
    password: form.password || undefined,
  };
}

/**
 * What the manager is told once the person is added: what they sign in with.
 *
 * Read from what was sent, so it never promises a password the server was not
 * given. `roster` is the staff this manager can see. Sign-in takes a mobile
 * number only while it and the password point at one person, so when somebody
 * else active already has the number the Login ID is given instead, and the
 * manager is told the number may now fail for that other person as well.
 */
export function staffAddedNote(
  created: StaffUser,
  sent: CreateStaffInput,
  roster: StaffUser[],
): string {
  if (!sent.password) {
    return `Their Login ID is ${created.email}. They have no password yet. Set one with Reset password on their row.`;
  }
  const mobile = normalizeIndianMobile(created.phone ?? "");
  const sameNumber = mobile
    ? roster.find(
        (u) =>
          u.isActive &&
          u.id !== created.id &&
          normalizeIndianMobile(u.phone ?? "") === mobile,
      )
    : undefined;
  return sameNumber
    ? `They sign in with Login ID ${created.email} and the password you set. ${sameNumber.name} has the same mobile number, so it may not work for either of them.`
    : `They sign in with their mobile number (or Login ID ${created.email}) and the password you set.`;
}
