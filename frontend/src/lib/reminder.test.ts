import { describe, expect, it } from "vitest";

import {
  followUpDoneBody,
  followUpDoneProblem,
  type FollowUpDoneDraft,
} from "@/lib/reminder";

/**
 * The "mark follow-up done" dialog, as the client described it (Nov):
 * a remark after every follow-up, an option to close the reminders when
 * everything is sorted, and a date for the one they want next month instead.
 *
 * The backend refuses the same things; these are the checks that tell the
 * counter before the request goes.
 */

const draft = (over: Partial<FollowUpDoneDraft> = {}): FollowUpDoneDraft => ({
  remark: "Spoke to customer — coming in Saturday to finalise.",
  next: "keep",
  nextDueDate: "",
  ...over,
});

describe("a remark after each follow-up", () => {
  it("will not save a follow-up with no remark", () => {
    expect(followUpDoneProblem(draft({ remark: "" }))?.field).toBe("remark");
  });

  it("will not save a remark of nothing but whitespace", () => {
    expect(followUpDoneProblem(draft({ remark: "   \n " }))?.field).toBe("remark");
  });

  it("will not save punctuation that says nothing", () => {
    expect(followUpDoneProblem(draft({ remark: "..." }))?.field).toBe("remark");
  });

  it("takes the words the counter actually uses", () => {
    expect(followUpDoneProblem(draft({ remark: "ok" }))).toBeNull();
    expect(followUpDoneProblem(draft({ remark: "Paid 20000" }))).toBeNull();
    expect(followUpDoneProblem(draft({ remark: "शनिवार को आएंगे" }))).toBeNull();
  });

  it("sends the remark trimmed", () => {
    expect(followUpDoneBody(draft({ remark: "  Called, will visit  " })).note).toBe(
      "Called, will visit",
    );
  });
});

describe("what happens to the rest of the schedule", () => {
  it("leaves it alone by default — being done with today is not being done", () => {
    const body = followUpDoneBody(draft());
    expect(body.stopReminders).toBeUndefined();
    expect(body.nextDueDate).toBeUndefined();
  });

  it("closes the reminders only when that is the choice", () => {
    expect(followUpDoneBody(draft({ next: "stop" })).stopReminders).toBe(true);
  });

  it("asks for the date before it can follow up later", () => {
    expect(followUpDoneProblem(draft({ next: "reschedule" }))?.field).toBe("nextDueDate");
  });

  it("sends the new date, and never alongside a stop", () => {
    const body = followUpDoneBody(draft({ next: "reschedule", nextDueDate: "2027-01-15" }));
    expect(followUpDoneProblem(draft({ next: "reschedule", nextDueDate: "2027-01-15" }))).toBeNull();
    expect(body.nextDueDate).toBe("2027-01-15");
    expect(body.stopReminders).toBeUndefined();
  });
});
