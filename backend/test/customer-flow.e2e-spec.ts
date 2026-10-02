/**
 * The customer qualification flow, exercised without a database or WhatsApp.
 *
 * Named `.e2e-spec.ts` only because that is what the runner matches; nothing
 * here touches a container. These are the decisions that turn a stranger's
 * reply into a scored lead, so they are worth pinning down cheaply.
 */
import {
  FLOW_STEPS,
  closingFor,
  greeting,
  stopConfirmation,
  reprompt,
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

/**
 * Customers do not answer a question with a number.
 *
 * Every string below is a plausible WhatsApp reply. Before this, each one was
 * unreadable and got "Sorry, I didn't quite catch that" — and two of those in a
 * row hand the lead to a person who must then start the conversation again.
 */
describe('customer flow — a real sentence, not a number', () => {
  it('reads what someone is shopping for', () => {
    expect(parseChoice(step('looking_for'), 'I am looking for an engagement ring')).toBe('engagement_ring');
    expect(parseChoice(step('looking_for'), 'need something for my wedding')).toBe('wedding_jewellery');
    expect(parseChoice(step('looking_for'), 'just daily wear pieces')).toBe('daily_wear');
  });

  /*
   * The "who is it for" question went the same way as the diamond-shape one:
   * pleasant to know, never acted on, and one more thing standing between an
   * interested person and a human being. Its synonyms stay in SYNONYMS keyed
   * by option value, where nothing reads them and nothing breaks.
   */

  it('reads a budget written as money rather than as a bracket', () => {
    expect(parseChoice(step('budget'), 'around 1 lakh')).toBe('50k_1l');
    expect(parseChoice(step('budget'), 'under 50k please')).toBe('under_50k');
    expect(parseChoice(step('budget'), 'more than 2 lakh')).toBe('above_2l');
  });

  it('reads a timeline in ordinary words', () => {
    expect(parseChoice(step('timeline'), 'need it this week')).toBe('within_7_days');
    expect(parseChoice(step('timeline'), 'just exploring for now')).toBe('exploring');
  });

  it('reads yes and no on the call question', () => {
    expect(parseChoice(step('call'), 'yes please')).toBe('call_now');
    expect(parseChoice(step('call'), 'no thanks')).toBe('not_now');
  });

  it('prefers the longer phrase when two could match', () => {
    // "morning" alone means tomorrow_morning; "tomorrow evening" must not be
    // read as "evening" -> later_today. Same rule as the ad-set matcher.
    expect(parseChoice(step('call_time'), 'tomorrow evening works')).toBe('tomorrow_pm');
    expect(parseChoice(step('call_time'), 'later today is fine')).toBe('later_today');
  });

  it('does NOT read a number buried in a sentence as an option', () => {
    // "1 lakh" is a budget, not option one. Reading it positionally would file
    // "Under ₹50K" for a customer who just said the opposite.
    expect(parseChoice(step('budget'), 'around 1 lakh')).not.toBe('under_50k');
  });

  it('still refuses a genuinely unreadable answer rather than guessing', () => {
    expect(parseChoice(step('looking_for'), 'hmm let me think about it')).toBeNull();
    expect(parseChoice(step('budget'), 'whatever it costs')).toBeNull();
  });

  it('reads whole words: a phrase is never found inside another word', () => {
    // Each of these filed a wrong answer when the text was matched as letters.
    // "now" holds "no": a customer asking to be called at once was filed as
    // "do not call", and nobody rang them.
    expect(parseChoice(step('call'), 'now')).toBe('call_now');
    expect(parseChoice(step('call'), 'right now')).toBe('call_now');
    expect(parseChoice(step('call'), 'not now')).toBe('not_now');
    expect(parseChoice(step('call'), "don't call")).toBe('not_now');
    expect(parseChoice(step('call'), 'I dont know')).toBeNull();
    expect(parseChoice(step('call'), 'afternoon is fine')).toBeNull();
    // "1.5 lakh" holds "5 lakh"; "earrings" holds "ring"; "home" holds "me".
    expect(parseChoice(step('budget'), '1.5 lakh')).toBe('1l_2l');
    expect(parseChoice(step('budget'), '1.5 lakh')).not.toBe('above_2l');
    expect(parseChoice(step('looking_for'), 'earrings')).toBeNull();
    expect(parseChoice(step('timeline'), 'in 2 weeks')).toBeNull();
  });

  it('never shows a numbered list, and never mentions numbers', () => {
    const prompt = promptFor(step('looking_for'));
    expect(prompt).not.toMatch(/Reply with a number/i);
    expect(prompt).not.toMatch(/send a number/i);
    // The giveaway this replaced: "1 — Engagement Ring". A numbered menu and an
    // em dash together announced the message as machine-written before it had
    // said anything.
    expect(prompt).not.toMatch(/\d\s*[—–-]\s*Engagement/);
    expect(prompt).toMatch(/your own words/i);
    // The options are still listed, just the way a person would list them.
    expect(prompt).toContain('Engagement Ring');
    expect(prompt).toContain('Other Jewellery');
  });
});

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
    expect(parseChoice(step('looking_for'), 'daily wear')).toBe('daily_wear');
    expect(parseChoice(step('looking_for'), 'WEDDING JEWELLERY')).toBe('wedding_jewellery');
  });

  it('reads an unambiguous prefix', () => {
    expect(parseChoice(step('timeline'), 'this mon')).toBe('this_month');
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
    // A bare rupee sign prefixes both "₹50K to ₹1L" and "₹1L to ₹2L". Picking
    // either would file a budget the customer never gave, and a mis-scored
    // lead is one nobody ever goes back and checks.
    expect(parseChoice(step('budget'), '₹')).toBeNull();
    // "Jewellery" ends two of the four options on the first question.
    expect(parseChoice(step('looking_for'), 'jewellery')).toBeNull();
  });
});

describe('customer flow — where the conversation goes next', () => {
  it('goes straight from timeline to the call ask, whatever they want', () => {
    // There used to be a branch here: an engagement ring was also asked its
    // diamond shape. That question is gone, so every path is the same path.
    const ring = { looking_for: 'engagement_ring' };
    expect(resolveNext(step('timeline'), 'this_month', ring)).toBe('call');

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
    expect(firstUnanswered({ looking_for: 'daily_wear' })).toBe('budget');
  });

  it('skips several and lands on the call ask', () => {
    const known = {
      looking_for: 'engagement_ring',
      budget: '1l_2l',
      timeline: 'this_month',
    };
    expect(firstUnanswered(known)).toBe('call');
  });

  it('returns null when everything has been answered', () => {
    const all = {
      looking_for: 'daily_wear',
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
  it('lists the options plainly, with no numbers and no dashes', () => {
    const text = promptFor(step('looking_for'));
    expect(text).toContain('Engagement Ring');
    expect(text).toContain('Other Jewellery');
    expect(text).toContain('your own words');
    // The two tells, both gone.
    expect(text).not.toMatch(/^\d+[.)]?\s/m);
    expect(text).not.toContain('—');
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
    expect(step('looking_for').prompt).toBe('What are you looking for today?');
    expect(step('budget').prompt).toBe('What is your approximate budget?');
    expect(step('timeline').prompt).toBe('When are you planning to purchase?');
  });

  it('asks four questions, and a fifth only to book a call', () => {
    // The count is the feature. Six questions with a branch is a form; four is
    // a conversation, and everything removed was something no salesperson read
    // before picking up the phone.
    expect(FLOW_STEPS.map((s) => s.key)).toEqual([
      'looking_for',
      'budget',
      'timeline',
      'call',
      'call_time',
    ]);
  });

  it('writes no dashes anywhere a customer can see one', () => {
    for (const s of FLOW_STEPS) {
      expect(s.prompt).not.toMatch(/[—–]/);
      for (const o of s.options) expect(o.label).not.toMatch(/[—–]/);
    }
    expect(greeting()).not.toMatch(/[—–]/);
    expect(greeting('Priya')).not.toMatch(/[—–]/);
    expect(reprompt()).not.toMatch(/[—–]/);
    expect(stopConfirmation()).not.toMatch(/[—–]/);
    for (const outcome of [
      { kind: 'handoff', reason: 'wants_call' },
      { kind: 'handoff', reason: 'wants_call_later' },
      { kind: 'handoff', reason: 'returning' },
      { kind: 'parked', reason: 'not_now' },
    ] as const) {
      expect(closingFor(outcome, 'Mumbai Bandra')).not.toMatch(/[—–]/);
      expect(closingFor(outcome)).not.toMatch(/[—–]/);
    }
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
      budget: '1l_2l',
      timeline: 'within_7_days',
    });
    expect(note).toContain('Engagement Ring');
    expect(note).toContain('Within 7 days');
    expect(note).toContain('₹1L to ₹2L');
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

describe('customer flow - someone who has already been through it', () => {
  it('acknowledges rather than re-asking', () => {
    // The whole point of the returning path: no question, and a clear promise
    // that a person is coming. Re-asking is what makes a bot feel like a form.
    const text = closingFor({ kind: 'handoff', reason: 'returning' });
    expect(text).toContain('again');
    expect(text).toContain('shortly');
    for (const s of FLOW_STEPS) {
      expect(text).not.toContain(s.prompt);
    }
  });

  it('reads differently from a first-time handoff', () => {
    const returning = closingFor({ kind: 'handoff', reason: 'returning' });
    const wantsCall = closingFor({ kind: 'handoff', reason: 'wants_call' });
    expect(returning).not.toBe(wantsCall);
  });

  it('names the branch when one is known', () => {
    expect(closingFor({ kind: 'handoff', reason: 'returning' }, 'Bandra')).toContain('Bandra');
  });

  it('still has an ending for every outcome the flow can produce', () => {
    // A missing case would return undefined and the customer would get nothing
    // at the exact moment the bot stops talking to them.
    const outcomes = [
      { kind: 'handoff', reason: 'wants_call' },
      { kind: 'handoff', reason: 'wants_call_later' },
      { kind: 'handoff', reason: 'gave_up' },
      { kind: 'handoff', reason: 'returning' },
      { kind: 'parked', reason: 'not_now' },
    ] as const;
    for (const o of outcomes) {
      expect(typeof closingFor(o)).toBe('string');
      expect(closingFor(o).length).toBeGreaterThan(0);
    }
  });
});
