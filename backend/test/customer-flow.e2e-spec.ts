/**
 * The customer qualification flow, exercised without a database or WhatsApp.
 *
 * Named `.e2e-spec.ts` only because that is what the runner matches; nothing
 * here touches a container. These are the decisions that turn a stranger's
 * reply into a scored lead, so they are worth pinning down cheaply.
 */
import {
  FLOW_STEPS,
  FIRST_STEP,
  MAX_REPROMPTS,
  firstUnanswered,
  handoffSummary,
  isStop,
  labelFor,
  parseChoice,
  promptFor,
  resolveNext,
  stepByKey,
  wantsHuman,
} from '../src/whatsapp-bot/customer-flow';

const step = (k: string) => {
  const s = stepByKey(k);
  if (!s) throw new Error(`no step ${k}`);
  return s;
};

describe('customer flow — reading an answer', () => {
  it('reads a position', () => {
    expect(parseChoice(step('looking_for'), '1')).toBe('engagement_ring');
    expect(parseChoice(step('looking_for'), '4')).toBe('other');
  });

  it('tolerates the punctuation people actually type', () => {
    expect(parseChoice(step('looking_for'), ' 2. ')).toBe('wedding_jewellery');
    expect(parseChoice(step('looking_for'), '3)')).toBe('daily_wear');
  });

  it('reads a label, case-insensitively', () => {
    expect(parseChoice(step('ring_shape'), 'oval')).toBe('oval');
    expect(parseChoice(step('ring_shape'), 'EMERALD')).toBe('emerald');
  });

  it('reads an unambiguous prefix', () => {
    expect(parseChoice(step('ring_shape'), 'prin')).toBe('princess');
  });

  it('refuses rather than guessing', () => {
    // Out of range, empty, and free text must all return null so the caller
    // re-asks. A guessed budget is a mis-scored lead nobody ever notices.
    expect(parseChoice(step('looking_for'), '9')).toBeNull();
    expect(parseChoice(step('looking_for'), '0')).toBeNull();
    expect(parseChoice(step('looking_for'), '')).toBeNull();
    expect(parseChoice(step('budget'), 'depends on the ring')).toBeNull();
  });

  it('refuses an ambiguous prefix instead of picking one', () => {
    // "p" matches both Princess and Pear.
    expect(parseChoice(step('ring_shape'), 'p')).toBeNull();
  });
});

describe('customer flow — where the conversation goes next', () => {
  it('asks about diamond shape only for an engagement ring', () => {
    const ring = { looking_for: 'engagement_ring' };
    expect(resolveNext(step('timeline'), 'this_month', ring)).toBe('ring_shape');

    const wedding = { looking_for: 'wedding_jewellery' };
    expect(resolveNext(step('timeline'), 'this_month', wedding)).toBe('call');
  });

  it('asks for a time only when the customer wants a call later', () => {
    expect(resolveNext(step('call'), 'call_later', {})).toBe('call_time');
    expect(resolveNext(step('call'), 'call_now', {})).toBeNull();
    expect(resolveNext(step('call'), 'not_now', {})).toBeNull();
  });

  it('ends after a time is chosen', () => {
    expect(resolveNext(step('call_time'), 'weekend', {})).toBeNull();
  });
});

describe('customer flow — not re-asking what the lead form already captured', () => {
  it('starts at the first question when nothing is known', () => {
    expect(firstUnanswered({})).toBe(FIRST_STEP);
  });

  it('skips a step the form already answered', () => {
    expect(firstUnanswered({ looking_for: 'daily_wear' })).toBe('who_for');
  });

  it('skips several, including across the ring branch', () => {
    const known = {
      looking_for: 'engagement_ring',
      who_for: 'partner',
      budget: '1l_2l',
      timeline: 'this_month',
    };
    expect(firstUnanswered(known)).toBe('ring_shape');
  });

  it('returns null when everything has been answered', () => {
    const all = {
      looking_for: 'daily_wear',
      who_for: 'myself',
      budget: 'under_50k',
      timeline: 'exploring',
      call: 'not_now',
    };
    expect(firstUnanswered(all)).toBeNull();
  });

  it('terminates on a malformed answer set rather than looping', () => {
    // A value no option matches must not spin resolveNext forever.
    expect(() => firstUnanswered({ looking_for: 'nonsense' })).not.toThrow();
  });
});

describe('customer flow — what the customer sees', () => {
  it('numbers the options and says how to reply', () => {
    const text = promptFor(step('looking_for'));
    expect(text).toContain('1 — Engagement Ring');
    expect(text).toContain('4 — Other Jewellery');
    expect(text).toContain('Reply with a number');
  });

  it('keeps every option short enough to become a WhatsApp list row', () => {
    // 24 characters is the cap. Exceeding it means silent truncation on a
    // phone, which is how an option stops meaning what it says.
    for (const s of FLOW_STEPS) {
      for (const o of s.options) {
        expect(o.label.length).toBeLessThanOrEqual(24);
      }
    }
  });

  it('uses the client-approved wording', () => {
    expect(step('who_for').prompt).toBe('Is this purchase for yourself or someone special?');
    expect(step('budget').prompt).toBe('What is your approximate budget?');
    expect(step('timeline').prompt).toBe('When are you planning to purchase?');
  });
});

describe('customer flow — escape hatches', () => {
  it('recognises an opt-out', () => {
    expect(isStop('stop')).toBe(true);
    expect(isStop('  STOP ')).toBe(true);
    expect(isStop('unsubscribe')).toBe(true);
    expect(isStop('stop asking me about rings')).toBe(false); // not a bare opt-out
  });

  it('recognises someone asking for a person', () => {
    expect(wantsHuman('call me')).toBe(true);
    expect(wantsHuman('can I speak to someone')).toBe(true);
    expect(wantsHuman('I want to talk to a manager')).toBe(true);
    expect(wantsHuman('2')).toBe(false);
  });

  it('allows two re-asks, not three', () => {
    expect(MAX_REPROMPTS).toBe(2);
  });
});

describe('customer flow — the note a manager picks up', () => {
  it('reads back the answers in labels, not codes', () => {
    const note = handoffSummary({
      looking_for: 'engagement_ring',
      who_for: 'partner',
      budget: '1l_2l',
    });
    expect(note).toContain('Engagement Ring');
    expect(note).toContain('Partner');
    expect(note).toContain('₹1L – ₹2L');
    expect(note).not.toContain('engagement_ring');
  });

  it('says so plainly when nothing was captured', () => {
    expect(handoffSummary({})).toContain('No answers captured');
  });

  it('labels resolve for every option in the flow', () => {
    for (const s of FLOW_STEPS) {
      for (const o of s.options) {
        expect(labelFor(s.key, o.value)).toBe(o.label);
      }
    }
  });
});
