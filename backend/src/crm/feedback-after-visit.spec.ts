import {
  MAX_DELAY_HOURS,
  MIN_DELAY_HOURS,
  type AfterVisitPolicy,
  afterVisitStepDueAt,
  afterVisitStepsAreOrdered,
  describeAfterVisit,
  mergeAfterVisit,
  readAfterVisit,
  secondAskOutcome,
  secondAskStep,
} from './feedback.service';

/**
 * Two feedback requests after a visit, not one.
 *
 * The client's words: "there are two templates that will go. One just after a
 * day a customer visits ... and second would go after 48 hours. And there
 * should be an option to set up second as well. Currently in the feedback
 * request if you go, there is just an option to add one."
 *
 * Two things are pinned here and they matter in different ways.
 *
 * The FIRST is compatibility. Nibhana has one request configured today, stored
 * under `delayDays` / `sendTimeLocal` / `templateName`, and the walk-in
 * scheduler still reads those keys. Nothing about that organisation may change
 * because a second step became possible, so the legacy shape is read, merged
 * and written back here and checked instant for instant.
 *
 * The SECOND is restraint. A second nag to somebody who already answered is
 * worse than no second message, so every reason not to send one is a test of
 * its own.
 */

const AT = (iso: string) => new Date(iso);
const IST = 'Asia/Kolkata';

/** Exactly what an organisation that configured one request has stored today. */
const LEGACY_STORED = {
  enabled: true,
  delayDays: 7,
  sendTimeLocal: '11:00',
  templateName: 'visit_feedback',
  templateLanguage: 'en',
};

describe('an organisation that configured one request before there were two', () => {
  it('reads its stored request as step one, unchanged', () => {
    const policy = readAfterVisit(LEGACY_STORED);

    expect(policy.enabled).toBe(true);
    expect(policy.delayDays).toBe(7);
    expect(policy.sendTimeLocal).toBe('11:00');
    expect(policy.templateName).toBe('visit_feedback');
    expect(policy.templateLanguage).toBe('en');
    expect(policy.steps[0]).toEqual({
      step: 1,
      enabled: true,
      delayHours: 7 * 24,
      sendTimeLocal: '11:00',
      templateName: 'visit_feedback',
      templateLanguage: 'en',
    });
  });

  it('gets no second request it did not ask for', () => {
    const policy = readAfterVisit(LEGACY_STORED);

    expect(policy.steps[1].enabled).toBe(false);
    expect(secondAskStep(policy)).toBeNull();
  });

  it('is asked at the same instant as before the second step existed', () => {
    const policy = readAfterVisit(LEGACY_STORED);
    // 23:30 on 1 November at the branch, which is the 1st in Kolkata and the
    // 1st in UTC too — the case the original rule was written for is a visit
    // whose local day and UTC day differ, so take one of those as well below.
    const due = afterVisitStepDueAt(AT('2026-11-01T18:00:00Z'), IST, policy.steps[0]);

    expect(due.toISOString()).toBe('2026-11-08T05:30:00.000Z'); // the 8th, 11:00 IST
  });

  it('is asked on the local day, not the UTC one', () => {
    const policy = readAfterVisit(LEGACY_STORED);
    // 00:30 on 2 November in Kolkata is still 1 November in UTC. The visit
    // happened on the 2nd as far as the branch is concerned.
    const due = afterVisitStepDueAt(AT('2026-11-01T19:00:00Z'), IST, policy.steps[0]);

    expect(due.toISOString()).toBe('2026-11-09T05:30:00.000Z'); // the 9th, 11:00 IST
  });

  it('survives a save that changes nothing else', () => {
    const merged = mergeAfterVisit(readAfterVisit(LEGACY_STORED), {});

    expect(merged.delayDays).toBe(7);
    expect(merged.sendTimeLocal).toBe('11:00');
    expect(merged.templateName).toBe('visit_feedback');
    expect(merged.steps[0].delayHours).toBe(7 * 24);
    expect(merged.steps[1].enabled).toBe(false);
  });

  it('still accepts a PATCH written against the old shape', () => {
    // A client that predates the second step sends the flat fields only.
    const merged = mergeAfterVisit(readAfterVisit(LEGACY_STORED), { delayDays: 3 });

    expect(merged.delayDays).toBe(3);
    expect(merged.steps[0].delayHours).toBe(3 * 24);
    expect(merged.steps[1].enabled).toBe(false);
  });

  it('keeps the two units in step, so the legacy key never disagrees', () => {
    // `delayDays` is what the walk-in scheduler reads and `delayHours` is what
    // the new rule reads. One setting must not mean two different days.
    const merged = mergeAfterVisit(readAfterVisit(LEGACY_STORED), {
      steps: [{ delayHours: 24 }],
    });

    expect(merged.steps[0].delayHours).toBe(24);
    expect(merged.delayDays).toBe(1);
    expect(afterVisitStepDueAt(AT('2026-11-01T18:00:00Z'), IST, merged.steps[0]).toISOString()).toBe(
      '2026-11-02T05:30:00.000Z',
    );
  });
});

describe('what a tenant who has configured nothing gets', () => {
  it('is off, with the client\'s own two delays waiting', () => {
    const policy = readAfterVisit(undefined);

    expect(policy.enabled).toBe(false);
    expect(policy.steps[0].delayHours).toBe(24);
    expect(policy.steps[1].delayHours).toBe(48);
    expect(policy.steps[1].enabled).toBe(false);
  });

  it('falls back to the defaults rather than throwing on nonsense in the column', () => {
    // `settings` is one JSONB column shared by unrelated features. A reader of
    // it must degrade, never throw: a policy that cannot be parsed would
    // otherwise take the walk-in checkout down with it.
    expect(readAfterVisit('not an object').steps[0].delayHours).toBe(24);
    expect(readAfterVisit({ delayDays: 0, sendTimeLocal: '25:61' }).steps[0]).toMatchObject({
      delayHours: 24,
      sendTimeLocal: '11:00',
    });
  });
});

describe('adding the second request', () => {
  const base = readAfterVisit(LEGACY_STORED);

  it('takes its own template, language and delay', () => {
    const merged = mergeAfterVisit(base, {
      steps: [undefined, { enabled: true, delayHours: 48, templateName: 'visit_feedback_2', templateLanguage: 'hi' }],
    });

    expect(merged.steps[1]).toEqual({
      step: 2,
      enabled: true,
      delayHours: 48,
      sendTimeLocal: '11:00',
      templateName: 'visit_feedback_2',
      templateLanguage: 'hi',
    });
    // And leaves the first one exactly where it was.
    expect(merged.steps[0].delayHours).toBe(7 * 24);
    expect(merged.steps[0].templateName).toBe('visit_feedback');
  });

  it('is not a request at all without a template of its own', () => {
    const merged = mergeAfterVisit(base, { steps: [undefined, { enabled: true, delayHours: 48 }] });

    // No staff-task fallback for the second one: the first already raises a
    // task when WhatsApp cannot carry it, and two tasks about one visit is work
    // nobody asked for.
    expect(secondAskStep(merged)).toBeNull();
  });

  it('goes nowhere while the whole automation is off', () => {
    const off = mergeAfterVisit(base, {
      enabled: false,
      steps: [undefined, { enabled: true, delayHours: 48, templateName: 'visit_feedback_2' }],
    });

    expect(secondAskStep(off)).toBeNull();
  });

  it('refuses a delay under a day, so the two units cannot diverge', () => {
    const merged = mergeAfterVisit(base, { steps: [{ delayHours: MIN_DELAY_HOURS - 1 }] });

    expect(merged.steps[0].delayHours).toBe(7 * 24); // the stored value stands
    expect(MIN_DELAY_HOURS).toBe(24);
    expect(MAX_DELAY_HOURS).toBe(60 * 24);
  });

  it('lets an empty template name mean "none", not "leave it as it was"', () => {
    // How the settings screen clears a template: it sends the empty box. If
    // that read as "unchanged" a manager could never take a template off.
    expect(mergeAfterVisit(base, { templateName: '' }).steps[0].templateName).toBeNull();
  });

  it('prefers the explicit step when a caller sends both spellings of the delay', () => {
    // A client that sends `steps` meant `steps`; `delayDays` is the older
    // spelling of the same fact, kept working, not given the casting vote.
    const both = mergeAfterVisit(base, { delayDays: 3, steps: [{ delayHours: 96 }] });

    expect(both.steps[0].delayHours).toBe(96);
    expect(both.delayDays).toBe(4);
  });
});

describe('the second request must land after the first', () => {
  const steps = (
    one: { delayHours: number; sendTimeLocal: string },
    two: { delayHours: number; sendTimeLocal: string; enabled?: boolean },
  ): AfterVisitPolicy['steps'] => [
    { step: 1, enabled: true, templateName: 'a', templateLanguage: 'en', ...one },
    { step: 2, enabled: two.enabled ?? true, templateName: 'b', templateLanguage: 'en', ...two },
  ];

  it('accepts a day then two days at the same hour', () => {
    expect(
      afterVisitStepsAreOrdered(
        steps({ delayHours: 24, sendTimeLocal: '11:00' }, { delayHours: 48, sendTimeLocal: '11:00' }),
      ),
    ).toBe(true);
  });

  it('refuses a later delay that still arrives earlier in the day', () => {
    // 24h at 18:00 is the evening of day one; 48h at 09:00 would be the morning
    // of day two — which is later, so this one is fine…
    expect(
      afterVisitStepsAreOrdered(
        steps({ delayHours: 24, sendTimeLocal: '18:00' }, { delayHours: 48, sendTimeLocal: '09:00' }),
      ),
    ).toBe(true);
    // …but the same day at an earlier hour is the chaser overtaking the request.
    expect(
      afterVisitStepsAreOrdered(
        steps({ delayHours: 48, sendTimeLocal: '18:00' }, { delayHours: 48, sendTimeLocal: '09:00' }),
      ),
    ).toBe(false);
  });

  it('refuses two requests at the same moment', () => {
    expect(
      afterVisitStepsAreOrdered(
        steps({ delayHours: 48, sendTimeLocal: '11:00' }, { delayHours: 48, sendTimeLocal: '11:00' }),
      ),
    ).toBe(false);
  });

  it('does not care about the order of a second request that is switched off', () => {
    expect(
      afterVisitStepsAreOrdered(
        steps(
          { delayHours: 48, sendTimeLocal: '18:00' },
          { delayHours: 24, sendTimeLocal: '09:00', enabled: false },
        ),
      ),
    ).toBe(true);
  });
});

describe('whether the second request goes out', () => {
  const NOW = AT('2026-11-16T10:00:00Z');
  /** A request the first message reached, with the second one due. */
  const due = {
    configured: true,
    status: 'sent',
    sentAt: AT('2026-11-15T05:30:00Z'),
    reminderDueAt: AT('2026-11-16T05:30:00Z'),
    reminderSentAt: null,
    repliedAt: null,
    respondedAt: null,
    rating: null,
    hasMatchedResponse: false,
    handedToStaffTaskId: null,
    contactable: true,
  };

  it('goes out when it is due and nothing has come back', () => {
    expect(secondAskOutcome(due, NOW)).toBe('send');
  });

  it('waits while it is early', () => {
    expect(secondAskOutcome({ ...due, reminderDueAt: AT('2026-11-17T05:30:00Z') }, NOW)).toBe('not_due');
  });

  it('never goes out when no second request is set up', () => {
    expect(secondAskOutcome({ ...due, configured: false }, NOW)).toBe('not_configured');
  });

  it('does not go twice', () => {
    expect(secondAskOutcome({ ...due, reminderSentAt: AT('2026-11-16T05:31:00Z') }, NOW)).toBe(
      'already_sent',
    );
  });

  describe('and above all not to somebody who already answered', () => {
    it('stops on a submitted form', () => {
      expect(secondAskOutcome({ ...due, respondedAt: AT('2026-11-15T09:00:00Z') }, NOW)).toBe(
        'already_answered',
      );
    });

    it('stops on a rating already on the row', () => {
      expect(secondAskOutcome({ ...due, rating: 5 }, NOW)).toBe('already_answered');
    });

    it('stops on a matched NPS response', () => {
      expect(secondAskOutcome({ ...due, hasMatchedResponse: true }, NOW)).toBe('already_answered');
    });

    it('stops on a request already marked answered', () => {
      expect(secondAskOutcome({ ...due, status: 'responded' }, NOW)).toBe('already_answered');
    });

    it('stops when they wrote back on WhatsApp without filling the form', () => {
      // A reply is NOT a submission — this codebase keeps the two apart on
      // purpose. It still stops the chaser: a reply means a colleague is in a
      // conversation with this customer, and a scheduled message landing in
      // the middle of it is the software talking over a person.
      expect(secondAskOutcome({ ...due, repliedAt: AT('2026-11-15T09:00:00Z') }, NOW)).toBe(
        'already_replied',
      );
    });
  });

  describe('and not as a follow-up to a message that never arrived', () => {
    it('stops when the first one has not left yet', () => {
      expect(secondAskOutcome({ ...due, sentAt: null }, NOW)).toBe('first_never_arrived');
    });

    it('stops when the first one was handed to a colleague instead', () => {
      expect(secondAskOutcome({ ...due, handedToStaffTaskId: 'task_1' }, NOW)).toBe(
        'first_never_arrived',
      );
    });

    it('stops when the first one was cancelled', () => {
      expect(secondAskOutcome({ ...due, status: 'cancelled' }, NOW)).toBe('first_never_arrived');
    });

    it('stops when the link has expired', () => {
      expect(secondAskOutcome({ ...due, status: 'expired' }, NOW)).toBe('first_never_arrived');
    });
  });

  it('stops for somebody who asked not to be contacted', () => {
    expect(secondAskOutcome({ ...due, contactable: false }, NOW)).toBe('not_contactable');
  });

  it('puts an answer ahead of a reply, and both ahead of the plumbing', () => {
    /*
     * The precedence is the design, so it is pinned rather than left to the
     * order the ifs happen to be written in. What a manager reads off the
     * screen is the REASON, and "they had already answered" is the true one
     * even when the first request also never arrived.
     */
    const replied = AT('2026-11-15T09:00:00Z');
    expect(secondAskOutcome({ ...due, repliedAt: replied, respondedAt: replied }, NOW)).toBe(
      'already_answered',
    );
    expect(
      secondAskOutcome({ ...due, repliedAt: replied, handedToStaffTaskId: 'task_1' }, NOW),
    ).toBe('already_replied');
    // Already sent outranks even an answer: it is the one guard about us
    // rather than about the customer, and it is what makes a retried sweep safe.
    expect(
      secondAskOutcome({ ...due, reminderSentAt: NOW, respondedAt: replied }, NOW),
    ).toBe('already_sent');
  });

  it('reads an absent rating as no answer rather than as one', () => {
    // The guard used to be `rating !== null`, which is true for `undefined` and
    // would have stopped every second request ever.
    const { rating: _dropped, ...withoutRating } = due;
    expect(secondAskOutcome(withoutRating, NOW)).toBe('send');
  });
});

describe('what the audit trail says about it', () => {
  it('names both requests when both are on', () => {
    const policy = mergeAfterVisit(readAfterVisit(LEGACY_STORED), {
      steps: [{ delayHours: 24 }, { enabled: true, delayHours: 48, templateName: 'visit_feedback_2' }],
    });

    expect(describeAfterVisit(policy)).toBe('on, 24h later at 11:00, then again 48h later at 11:00');
  });

  it('says plainly when there is only one', () => {
    expect(describeAfterVisit(readAfterVisit(LEGACY_STORED))).toBe(
      'on, 168h later at 11:00, no second request',
    );
  });

  it('says off when it is off', () => {
    expect(describeAfterVisit(readAfterVisit({ ...LEGACY_STORED, enabled: false }))).toBe('off');
  });
});
