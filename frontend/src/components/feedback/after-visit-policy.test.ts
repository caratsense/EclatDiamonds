import { describe, expect, it } from "vitest";

import type { AfterVisitPolicy, AfterVisitStep } from "@/lib/queries/feedback";
import {
  afterVisitSteps,
  secondRequestIsSendable,
  stepsAreOrdered,
  whenItGoesOut,
} from "@/components/feedback/after-visit-policy";

/**
 * The Feedback Requests screen offers two requests now, not one, and has to
 * draw a branch's existing single request correctly while it does.
 *
 * The client's words: "there are two templates that will go. One just after a
 * day a customer visits ... and second would go after 48 hours. And there
 * should be an option to set up second as well."
 */

/** What the settings endpoint returns for an organisation with one request. */
const LEGACY: AfterVisitPolicy = {
  enabled: true,
  delayDays: 7,
  sendTimeLocal: "11:00",
  templateName: "visit_feedback",
  templateLanguage: "en",
};

const step = (over: Partial<AfterVisitStep> & { step: 1 | 2 }): AfterVisitStep => ({
  enabled: true,
  delayHours: 24,
  sendTimeLocal: "11:00",
  templateName: "visit_feedback",
  templateLanguage: "en",
  ...over,
});

describe("reading both steps off the settings endpoint", () => {
  it("takes the steps the server sent", () => {
    const sent = {
      ...LEGACY,
      steps: [
        step({ step: 1, delayHours: 24 }),
        step({ step: 2, delayHours: 48, templateName: "visit_feedback_reminder" }),
      ],
    } as AfterVisitPolicy;

    const [first, second] = afterVisitSteps(sent);

    expect(first.delayHours).toBe(24);
    expect(second.delayHours).toBe(48);
    expect(second.templateName).toBe("visit_feedback_reminder");
  });

  it("still draws the request a branch has configured when no steps are sent", () => {
    // A deployment that predates the second step. The screen must show the
    // seven-day request that branch actually has, not an empty form.
    const [first, second] = afterVisitSteps(LEGACY);

    expect(first.delayHours).toBe(7 * 24);
    expect(first.sendTimeLocal).toBe("11:00");
    expect(first.templateName).toBe("visit_feedback");
    expect(second.enabled).toBe(false);
  });
});

describe("the second request must land after the first", () => {
  it("accepts a day then two days at the same hour", () => {
    expect(
      stepsAreOrdered([
        step({ step: 1, delayHours: 24 }),
        step({ step: 2, delayHours: 48 }),
      ]),
    ).toBe(true);
  });

  it("refuses a chaser that overtakes the request it chases", () => {
    // Same day, earlier hour. The server refuses this too; saying so on the
    // screen saves a round trip and an error toast.
    expect(
      stepsAreOrdered([
        step({ step: 1, delayHours: 48, sendTimeLocal: "18:00" }),
        step({ step: 2, delayHours: 48, sendTimeLocal: "09:00" }),
      ]),
    ).toBe(false);
  });

  it("does not block a save because a switched-off second request is out of order", () => {
    expect(
      stepsAreOrdered([
        step({ step: 1, delayHours: 48 }),
        step({ step: 2, delayHours: 24, enabled: false }),
      ]),
    ).toBe(true);
  });
});

describe("a second request that would send nothing", () => {
  it("is caught before it can be saved", () => {
    // Ticking the box and leaving the template empty stores a second request
    // that goes out never: unlike the first it has no staff-task fallback.
    expect(
      secondRequestIsSendable([
        step({ step: 1 }),
        step({ step: 2, delayHours: 48, templateName: null }),
      ]),
    ).toBe(false);
    expect(
      secondRequestIsSendable([
        step({ step: 1 }),
        step({ step: 2, delayHours: 48, templateName: "   " }),
      ]),
    ).toBe(false);
  });

  it("does not block anything while the second request is switched off", () => {
    expect(
      secondRequestIsSendable([
        step({ step: 1 }),
        step({ step: 2, enabled: false, templateName: null }),
      ]),
    ).toBe(true);
  });
});

describe("saying when each one goes out", () => {
  it("calls a day a day", () => {
    expect(whenItGoesOut(step({ step: 1, delayHours: 24 }))).toBe(
      "24 hours after the visit — the next day at 11:00, branch time.",
    );
  });

  it("counts the days for anything longer", () => {
    expect(whenItGoesOut(step({ step: 2, delayHours: 48, sendTimeLocal: "09:30" }))).toBe(
      "48 hours after the visit — 2 days later at 09:30, branch time.",
    );
  });
});
