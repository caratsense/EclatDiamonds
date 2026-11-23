import type { AfterVisitPolicy, AfterVisitStep } from "@/lib/queries/feedback";

/**
 * How the Feedback Requests screen reads and checks the two requests that go
 * out after a visit.
 *
 * The client asked for the delays in hours — "one just after a day a customer
 * visits ... and second would go after 48 hours" — so hours is the unit on the
 * screen. The send is still pinned to the branch's own time of day, because 48
 * hours after a visit that ended at 23:30 is 23:30, and a jeweller does not
 * message a customer in the middle of the night.
 *
 * The shape itself lives in lib/queries/feedback: one definition of the
 * settings object, not one per screen.
 */

/** A day is the floor, and sixty days the ceiling. Both match the server. */
export const MIN_DELAY_HOURS = 24;
export const MAX_DELAY_HOURS = 60 * 24;

/**
 * Both steps out of whatever the settings endpoint returned.
 *
 * Step one falls back to the flattened `delayDays` / `sendTimeLocal` /
 * `templateName` fields the policy has always carried, so this screen still
 * draws the request a branch actually has configured even when talking to a
 * deployment that predates the second step.
 */
export function afterVisitSteps(policy: AfterVisitPolicy): [AfterVisitStep, AfterVisitStep] {
  const sent = policy.steps;
  const first: AfterVisitStep = sent?.[0] ?? {
    step: 1,
    enabled: policy.enabled,
    delayHours: Math.max(policy.delayDays, 1) * 24,
    sendTimeLocal: policy.sendTimeLocal,
    templateName: policy.templateName,
    templateLanguage: policy.templateLanguage,
  };
  const second: AfterVisitStep = sent?.[1] ?? {
    step: 2,
    enabled: false,
    delayHours: 48,
    sendTimeLocal: policy.sendTimeLocal,
    templateName: null,
    templateLanguage: null,
  };
  return [first, second];
}

/** Minutes from the visit's own local midnight to when a step goes out. */
function offsetMinutes(step: AfterVisitStep): number {
  const [h, m] = step.sendTimeLocal.split(":");
  return (
    Math.floor(step.delayHours / 24) * 24 * 60 + (Number(h) || 0) * 60 + (Number(m) || 0)
  );
}

/**
 * Does the second request actually land after the first?
 *
 * Compared as offsets rather than hours because both are pinned to a time of
 * day: 48 hours at 09:00 is earlier in the day than 48 hours at 18:00, and a
 * chaser that arrives before the request it chases is the one arrangement
 * nobody means. The server refuses it too; saying so here saves a round trip
 * and an error toast.
 */
export function stepsAreOrdered(steps: [AfterVisitStep, AfterVisitStep]): boolean {
  if (!steps[1].enabled) return true;
  return offsetMinutes(steps[1]) > offsetMinutes(steps[0]);
}

/**
 * Is the second request set up well enough to actually go out?
 *
 * One with no template sends nothing. Unlike the first request it has no
 * staff-task fallback — the first already raises a task when WhatsApp cannot
 * carry it, and a second task telling a colleague to nag the same customer
 * again is work nobody asked for. The server stores that state without
 * complaint, because a policy reader must never throw on what is already in
 * the database, so the screen is where it has to be caught: a ticked box that
 * quietly sends nothing is worse than no box.
 */
export function secondRequestIsSendable(steps: [AfterVisitStep, AfterVisitStep]): boolean {
  if (!steps[1].enabled) return true;
  return Boolean(steps[1].templateName?.trim());
}

/** When a step goes out, in words rather than numbers. */
export function whenItGoesOut(step: AfterVisitStep): string {
  const days = Math.floor(step.delayHours / 24);
  const day = days <= 1 ? "the next day" : `${days} days later`;
  return `${step.delayHours} hours after the visit — ${day} at ${step.sendTimeLocal}, branch time.`;
}
