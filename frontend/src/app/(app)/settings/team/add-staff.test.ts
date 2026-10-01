import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { StaffUser } from "@/lib/queries/users";

import { addStaffInput, staffAddedNote } from "./add-staff";

/**
 * A manager hands out a working login in one form: Add staff sends the
 * password too, and then says plainly what the person signs in with. The
 * server's half is backend/test/add-staff-with-password.e2e-spec.ts.
 */

const typed = {
  name: " Nisha Rao ",
  phone: "9744000001",
  email: " nisha@home.example ",
  storeId: "store_counter",
  role: "salesperson" as const,
  password: "day1pass",
};

const person = (over: Partial<StaffUser> = {}): StaffUser => ({
  id: "u_nisha",
  name: "Nisha Rao",
  email: "nisha.counter@asp.in",
  phone: "9744000001",
  role: "salesperson",
  stores: [{ id: "store_counter", name: "Counter" }],
  isActive: true,
  ...over,
});

describe("what Add staff sends", () => {
  it("is what was typed, the password included", () => {
    expect(addStaffInput(typed)).toEqual({
      name: "Nisha Rao",
      phone: "9744000001",
      email: "nisha@home.example",
      storeId: "store_counter",
      role: "salesperson",
      password: "day1pass",
    });
  });

  it("leaves a blank password out, which the server would refuse", () => {
    const sent = addStaffInput({ ...typed, password: "" });
    expect(sent.password).toBeUndefined();
    // Not even as an empty field: JSON drops what is undefined.
    expect(JSON.stringify(sent)).not.toContain("password");
  });
});

describe("what the manager is told once the person is added", () => {
  const withPassword = addStaffInput(typed);
  const withoutPassword = addStaffInput({ ...typed, password: "" });
  const BY_MOBILE =
    "They sign in with their mobile number (or Login ID nisha.counter@asp.in) and the password you set.";

  it("is the mobile number, or the Login ID, and the password", () => {
    expect(staffAddedNote(person(), withPassword, [person()])).toBe(BY_MOBILE);
  });

  it("is that they have no password yet, when none was sent", () => {
    // Not "cannot sign in": the account is live, it only lacks a password.
    expect(staffAddedNote(person(), withoutPassword, [person()])).toBe(
      "Their Login ID is nisha.counter@asp.in. They have no password yet. Set one with Reset password on their row.",
    );
  });

  it("is the Login ID alone when someone else active has the number", () => {
    // Numbers are stored as typed, so the two are compared digit for digit.
    const ravi = person({ id: "u_ravi", name: "Ravi Kumar", phone: "+91 97440 00001" });
    expect(staffAddedNote(person(), withPassword, [ravi, person()])).toBe(
      "They sign in with Login ID nisha.counter@asp.in and the password you set. Ravi Kumar has the same mobile number, so it may not work for either of them.",
    );
  });

  it("does not count someone switched off, or another number, or none", () => {
    const left = person({ id: "u_left", isActive: false });
    const other = person({ id: "u_other", phone: "9744000002" });
    const none = person({ id: "u_none", phone: null });
    expect(staffAddedNote(person(), withPassword, [left, other, none])).toBe(BY_MOBILE);
  });
});

describe("the Add staff dialog", () => {
  /*
   * With every field stacked it is taller than a phone screen, and a dialog
   * does not close on a tap outside it, so Cancel and Close were out of reach.
   * Read from the source: a dialog opens in a portal, which a server render
   * leaves out, and how tall it comes out needs a browser to say.
   */
  it("scrolls inside the screen instead of running off it", () => {
    const page = readFileSync(
      fileURLToPath(new URL("./page.tsx", import.meta.url)),
      "utf8",
    );
    const classes =
      page.match(
        /<DialogContent([^>]*)>\s*<DialogHeader>\s*<DialogTitle>Add staff</,
      )?.[1] ?? "";
    expect(classes).toMatch(/max-h-\[\d+d?vh\]/);
    expect(classes).toContain("overflow-y-auto");
  });
});
