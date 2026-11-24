import { describe, expect, it } from "vitest";

import {
  branchZone,
  dayBucket,
  daySeparator,
  lastInteraction,
  messageTime,
  threadStamp,
  zonedDayKey,
} from "@/lib/conversation-time";

/**
 * "Is this today" is wrong for an hour a day and nobody notices.
 *
 * Which is the whole reason these rules are a tested function rather than a
 * ternary in the inbox: every assertion below passes for twenty-three hours a
 * day under ANY implementation, including a wrong one. The two that matter are
 * 23:59 and 00:01 — two minutes apart, two different days — and the pair that
 * reads the same instant in the branch's zone and in UTC and gets different
 * answers, which is exactly what a laptop or a server clock would have done.
 *
 * Locale is pinned to en-US so the expected strings are the client's own
 * screenshot ("12:25 PM", "10/14/2026") rather than whatever the machine
 * running the tests happens to be set to.
 */
const IST = "Asia/Kolkata";
const en = { locale: "en-US" };

/** 11:30 on Tuesday 24 November 2026, in Surat. */
const NOW = new Date("2026-11-24T06:00:00Z");

const ist = (opts: { now?: Date } = {}) => ({
  timeZone: IST,
  now: opts.now ?? NOW,
  ...en,
});

describe("which branch clock decides the day", () => {
  it("falls back to the chain's own zone when a thread has no branch", () => {
    expect(branchZone(null)).toBe("Asia/Kolkata");
    expect(branchZone(undefined)).toBe("Asia/Kolkata");
    expect(branchZone("")).toBe("Asia/Kolkata");
  });

  it("falls back rather than throwing on a zone nobody can format in", () => {
    // A typo in a store row must degrade, never break the inbox mid-read.
    expect(branchZone("Asia/Kolkatta")).toBe("Asia/Kolkata");
  });

  it("keeps a real zone", () => {
    expect(branchZone("America/New_York")).toBe("America/New_York");
  });

  it("reads the calendar day in the branch's zone, not the server's", () => {
    // 00:30 on the 25th in Surat is 19:00 on the 24th in UTC. One instant,
    // two different dates — and the branch's is the one a salesperson means.
    const justAfterMidnight = "2026-11-24T19:00:00Z";
    expect(zonedDayKey(justAfterMidnight, IST)).toBe("2026-11-25");
    expect(zonedDayKey(justAfterMidnight, "UTC")).toBe("2026-11-24");
  });

  it("returns nothing for a stamp it cannot read", () => {
    expect(zonedDayKey(null, IST)).toBe("");
    expect(zonedDayKey("not a date", IST)).toBe("");
  });
});

describe("how near a message is", () => {
  it("counts 23:59 and 00:01 as different days", () => {
    // 23:59 on the 23rd and 00:01 on the 24th, both in Surat. Two minutes
    // apart. Anything that compares elapsed milliseconds calls both "yesterday".
    expect(dayBucket("2026-11-23T18:29:00Z", ist())).toBe("yesterday");
    expect(dayBucket("2026-11-23T18:31:00Z", ist())).toBe("today");
  });

  it("does not read a late-evening message as the previous day", () => {
    // 23:30 IST on the 24th. This is the case the client would have hit first:
    // under a UTC reading it is still the 24th, under a browser roaming in
    // New York it is the 24th at 13:00 — but the branch says today, late.
    expect(dayBucket("2026-11-24T18:00:00Z", ist())).toBe("today");
  });

  it("names six days ago by its weekday and seven days ago by its date", () => {
    // Seven days ago is the SAME weekday as today, so "Tuesday" would name
    // two days with one word. That is where the weekday has to stop.
    expect(dayBucket("2026-11-18T06:00:00Z", ist())).toBe("this_week");
    expect(dayBucket("2026-11-17T06:00:00Z", ist())).toBe("older");
    expect(dayBucket("2026-11-16T06:00:00Z", ist())).toBe("older");
  });

  it("treats a stamp from the future as today", () => {
    // A provider clock a few seconds ahead. "Tomorrow" is never a useful thing
    // to say about a message somebody is looking at.
    expect(dayBucket("2026-11-25T06:00:00Z", ist())).toBe("today");
  });

  it("gives the same instant different answers in different branches", () => {
    const instant = "2026-11-24T19:00:00Z";
    expect(dayBucket(instant, { timeZone: IST, now: NOW, ...en })).toBe("today");
    expect(dayBucket(instant, { timeZone: "UTC", now: NOW, ...en })).toBe("today");
    // ...and on the 25th in Surat it is still today, while UTC has moved on.
    const next = new Date("2026-11-25T04:00:00Z");
    expect(dayBucket(instant, { timeZone: IST, now: next, ...en })).toBe("today");
    expect(dayBucket(instant, { timeZone: "UTC", now: next, ...en })).toBe("yesterday");
  });

  it("says nothing it cannot work out", () => {
    expect(dayBucket(null, ist())).toBeNull();
    expect(dayBucket("", ist())).toBeNull();
  });
});

describe("the time on a bubble", () => {
  it("writes the time the way WhatsApp does, with no leading zero", () => {
    expect(messageTime("2026-11-23T18:31:00Z", { timeZone: IST, ...en })).toBe("12:01 AM");
    expect(messageTime("2026-11-24T18:00:00Z", { timeZone: IST, ...en })).toBe("11:30 PM");
    expect(messageTime("2026-11-24T06:55:00Z", { timeZone: IST, ...en })).toBe("12:25 PM");
  });

  it("is the branch's clock, not the reader's", () => {
    const instant = "2026-11-24T18:00:00Z";
    expect(messageTime(instant, { timeZone: IST, ...en })).toBe("11:30 PM");
    expect(messageTime(instant, { timeZone: "UTC", ...en })).toBe("6:00 PM");
  });

  it("prints nothing rather than 'Invalid Date'", () => {
    expect(messageTime(null, { timeZone: IST, ...en })).toBe("");
    expect(messageTime("yesterday-ish", { timeZone: IST, ...en })).toBe("");
  });
});

describe("the stamp beside a thread in the list", () => {
  it("shows the four shapes the client's screenshot shows", () => {
    expect(threadStamp("2026-11-24T06:55:00Z", ist())).toBe("12:25 PM");
    expect(threadStamp("2026-11-23T18:29:00Z", ist())).toBe("Yesterday");
    expect(threadStamp("2026-11-18T06:00:00Z", ist())).toBe("Wednesday");
    expect(threadStamp("2026-10-14T06:00:00Z", ist())).toBe("10/14/2026");
  });

  it("switches from weekday to date at seven days", () => {
    expect(threadStamp("2026-11-18T06:00:00Z", ist())).toBe("Wednesday");
    expect(threadStamp("2026-11-17T06:00:00Z", ist())).toBe("11/17/2026");
    expect(threadStamp("2026-11-16T06:00:00Z", ist())).toBe("11/16/2026");
  });

  it("is empty for a thread with nothing on it", () => {
    expect(threadStamp(null, ist())).toBe("");
  });
});

describe("the day pill inside a thread", () => {
  it("names today and yesterday in words", () => {
    // Uppercased by the pill itself, so these read as TODAY and YESTERDAY.
    expect(daySeparator("2026-11-24T06:55:00Z", ist())).toBe("Today");
    expect(daySeparator("2026-11-23T18:29:00Z", ist())).toBe("Yesterday");
  });

  it("names a recent day by its weekday and an old one by its date", () => {
    expect(daySeparator("2026-11-18T06:00:00Z", ist())).toBe("Wednesday");
    expect(daySeparator("2026-10-14T06:00:00Z", ist())).toBe("10/14/2026");
  });

  it("says Today for a bubble stamped a minute into tomorrow", () => {
    // Not "11/25/2026" against a message sitting below one marked Today.
    expect(daySeparator("2026-11-25T06:00:00Z", ist())).toBe("Today");
  });
});

describe("when we last heard from them", () => {
  it("says the day and the time together", () => {
    expect(lastInteraction("2026-11-24T06:55:00Z", ist())).toBe("today at 12:25 PM");
    expect(lastInteraction("2026-11-23T18:29:00Z", ist())).toBe("yesterday at 11:59 PM");
    expect(lastInteraction("2026-11-18T06:00:00Z", ist())).toBe("Wednesday at 11:30 AM");
    expect(lastInteraction("2026-10-14T06:00:00Z", ist())).toBe("10/14/2026 at 11:30 AM");
  });

  it("is empty when they have never written", () => {
    expect(lastInteraction(null, ist())).toBe("");
  });
});
