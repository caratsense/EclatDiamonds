import {
  DID_NOT_ARRIVE,
  RETRY_COOLDOWN_HOURS,
  retryCooldownSince,
  retryPlan,
} from './campaign-retry';

/**
 * The rule these are written against, in the numbers that produced it: on the
 * nails-event broadcast 80% of the people tried twice were reached, 9% of those
 * tried three times were, and nobody tried four times was. Meta caps marketing
 * per recipient (error 131049), so a re-send to somebody messaged an hour ago
 * spends their allowance and is the likeliest way to have them refused again.
 *
 * So the figures pinned here are the ones a manager reads before pressing the
 * button: what will actually be sent, and what is being held back.
 */

describe('what a re-send will actually send to', () => {
  it('holds back everyone messaged inside the cooldown', () => {
    const plan = retryPlan({ retryable: 71, messagedRecently: 59 });
    expect(plan.heldBack).toBe(59);
    expect(plan.willSend).toBe(12);
  });

  it('says what the override would send to, so the choice is a real one', () => {
    const plan = retryPlan({ retryable: 71, messagedRecently: 59 });
    expect(plan.willSendWithOverride).toBe(71);
  });

  it('sends to the whole group once somebody deliberately overrides', () => {
    const plan = retryPlan({ retryable: 71, messagedRecently: 59, includeRecentlyMessaged: true });
    expect(plan.heldBack).toBe(0);
    expect(plan.willSend).toBe(71);
  });

  it('holds back nobody when nobody has been messaged recently', () => {
    const plan = retryPlan({ retryable: 12, messagedRecently: 0 });
    expect(plan.heldBack).toBe(0);
    expect(plan.willSend).toBe(12);
  });

  it('never promises a negative send when the two counts disagree', () => {
    // The counts come from two queries taken a moment apart, so a receipt that
    // lands between them can make the hold-back larger than the group it is
    // held back from. A screen reading "-3 people" is worse than either number.
    const plan = retryPlan({ retryable: 4, messagedRecently: 9 });
    expect(plan.heldBack).toBe(4);
    expect(plan.willSend).toBe(0);
  });

  it('reports the window it is holding back on', () => {
    expect(retryPlan({ retryable: 1, messagedRecently: 0 }).cooldownHours).toBe(
      RETRY_COOLDOWN_HOURS,
    );
  });
});

describe('the cooldown window', () => {
  it('is the same 24 hours the retry script holds back on', () => {
    expect(RETRY_COOLDOWN_HOURS).toBe(24);
  });

  it('puts the cutoff exactly that many hours before now', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    expect(retryCooldownSince(now).toISOString()).toBe('2026-11-20T12:00:00.000Z');
  });

  it('honours a different window when one is given', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    expect(retryCooldownSince(now, 6).toISOString()).toBe('2026-11-21T06:00:00.000Z');
  });
});

describe('which recipients a re-send is allowed to touch', () => {
  it('covers the whole "Did not arrive" tab, given up included', () => {
    // `attempts` is never reset, so a row that failed twice becomes 'dead' and
    // could never be tried again — which is why the retry script had to exist
    // and why 125 people were stranded where the screen's button could not
    // reach them. A button on that tab has to mean the whole tab.
    expect([...DID_NOT_ARRIVE].sort()).toEqual(['dead', 'failed']);
  });

  it('never touches an excluded recipient', () => {
    // 'excluded' means consent or policy said no. Re-sending to somebody who
    // replied STOP is the worst thing this button could do.
    expect(DID_NOT_ARRIVE).not.toContain('excluded');
  });

  it('never touches someone who already received it', () => {
    for (const reached of ['sent', 'delivered', 'read']) {
      expect(DID_NOT_ARRIVE).not.toContain(reached);
    }
  });
});
