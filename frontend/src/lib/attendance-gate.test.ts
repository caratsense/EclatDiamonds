import { describe, expect, it } from "vitest";

import { attendanceGateStep } from "./attendance-gate";

/**
 * The attendance gate sends anyone who has not dealt with today's attendance to
 * the punch screen. What it does on a given screen is one pure function, so a
 * signed-in session is walked here from screen to screen without a browser:
 * the gate's answer is acted on the way the gate component acts on it, and
 * followed when it sends the person to the punch screen.
 */
function session(person: { punchScreenIsHome: boolean; punches?: boolean }) {
  // Signing in clears the flag. Nobody has punched yet.
  let handled = false;
  let today: object | null | undefined = null;
  let path = "";
  const s = {
    /** Open a screen. Where the person ends up is `path`. */
    open(next: string) {
      path = next;
      const step = attendanceGateStep({
        punches: person.punches ?? true,
        onPunchScreen: path === "/check-in",
        punchScreenIsHome: person.punchScreenIsHome,
        handled,
        today,
      });
      if (step === "mark-handled") handled = true;
      if (step === "to-punch-screen") s.open("/check-in");
      return s;
    },
    /** "Skip for now" sets the flag; so does a punch. */
    skip() {
      handled = true;
      return s;
    },
    /** Today already has a record: a punch from another phone, or a manager's entry. */
    recordedToday() {
      today = { id: "a1" };
      return s;
    },
    /** Today's attendance has not come back from the server yet. */
    stillLoading() {
      today = undefined;
      return s;
    },
    get path() {
      return path;
    },
    get handled() {
      return handled;
    },
  };
  return s;
}

describe("someone set to attendance only", () => {
  const attendanceOnly = { punchScreenIsHome: true };

  it("opens leave from the punch screen without being sent back to it", () => {
    // They have no "Skip for now", so nothing else would have set the flag, and
    // leave and fixing attendance could not be opened until they had punched.
    expect(session(attendanceOnly).open("/check-in").open("/hrms").path).toBe("/hrms");
  });

  it("still starts on the punch screen when the app is reopened elsewhere", () => {
    const reopened = session(attendanceOnly).open("/hrms");
    expect(reopened.path).toBe("/check-in");
    expect(reopened.open("/hrms").path).toBe("/hrms");
  });
});

describe("everyone else", () => {
  const sales = { punchScreenIsHome: false };

  it("is sent to the punch screen until they punch or skip", () => {
    expect(session(sales).open("/crm").path).toBe("/check-in");
    // Being on the punch screen does not count for them. Skipping does.
    expect(session(sales).open("/check-in").open("/crm").path).toBe("/check-in");
    expect(session(sales).open("/check-in").skip().open("/crm").path).toBe("/crm");
  });

  it("is left where they are once today has a record, and not asked again", () => {
    const s = session(sales).recordedToday().open("/crm");
    expect(s.path).toBe("/crm");
    expect(s.handled).toBe(true);
  });

  it("is not sent anywhere while today's attendance is still loading", () => {
    const s = session(sales).stillLoading().open("/crm");
    expect(s.path).toBe("/crm");
    expect(s.handled).toBe(false);
  });
});

describe("head office", () => {
  it("is never sent to the punch screen: they do not punch", () => {
    const s = session({ punchScreenIsHome: false, punches: false }).open("/dashboards");
    expect(s.path).toBe("/dashboards");
    expect(s.handled).toBe(false);
  });
});
