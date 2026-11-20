/**
 * The scoring policy has to understand the bot's own answers.
 *
 * Named `.e2e-spec.ts` only because that is what the runner matches; nothing
 * here touches a container.
 *
 * The default signal phrases were written for a customer typing freely — "want
 * to buy", "my budget", "this week". Most Éclat leads never type freely: the
 * qualification bot asks four closed questions and the customer answers with
 * the bot's own option labels. Those labels contained none of those phrases,
 * so on 5 Oct a lead that had asked for an engagement ring above ₹2L within
 * seven days and said "yes, call me now" scored 0 and rendered "Do not
 * pursue".
 *
 * These tests score the transcripts the bot actually produces, so a future
 * edit to either side that breaks the pairing fails here.
 */
import {
  DEFAULT_QUALIFICATION_POLICY,
  matchSignals,
  scoreSignals,
} from '../src/crm/qualification-policy';
import { FLOW_STEPS } from '../src/whatsapp-bot/customer-flow';

const policy = DEFAULT_QUALIFICATION_POLICY;
const score = (transcript: string) => scoreSignals(policy, matchSignals(policy, transcript));
const fired = (transcript: string) =>
  matchSignals(policy, transcript).filter((s) => s.matched).map((s) => s.key);

/** What the inbox stores for a lead who answered every question at the top end. */
const BEST_LEAD = [
  'Hi, I would like to know more about Éclat jewellery.',
  'Engagement Ring',
  'Above ₹2L',
  'Within 7 days',
  'Yes, call me now',
].join('\n');

/** The same flow, answered by somebody who is not buying. */
const BROWSER = [
  'Hi, I would like to know more about Éclat jewellery.',
  'Daily Wear',
  'Under ₹50K',
  'Just exploring',
  'Not right now',
].join('\n');

describe('qualification understands the bot\'s own answer labels', () => {
  it('scores the best lead the bot can produce well above zero', () => {
    const { score: n } = score(BEST_LEAD);
    // The exact number may move as weights are tuned; zero is the bug.
    expect(n).toBeGreaterThan(0);
  });

  it('fires budget, timeline and purchase intent from option labels alone', () => {
    const keys = fired(BEST_LEAD);
    expect(keys).toContain('budget_stated');
    expect(keys).toContain('timeline_soon');
    expect(keys).toContain('purchase_intent');
  });

  it('does not land that lead in the worst band', () => {
    const { band } = score(BEST_LEAD);
    // "Do not pursue" for somebody asking to be phoned about a ₹2L+ ring was
    // the reported symptom.
    expect(band?.recommendedAction ?? '').not.toMatch(/do not pursue/i);
  });

  it('still scores a browser lower than a buyer', () => {
    // The fix must not make every lead hot. "Just exploring" and "Not right
    // now" are real answers and deserve the low score they get.
    expect(score(BROWSER).score).toBeLessThan(score(BEST_LEAD).score);
  });

  it('does not treat "in a few months" or "just exploring" as urgency', () => {
    expect(fired('In a few months')).not.toContain('timeline_soon');
    expect(fired('Just exploring')).not.toContain('timeline_soon');
  });

  it('reads a budget band typed back by hand, without the rupee sign', () => {
    // People retype the option instead of tapping it, and drop the ₹.
    expect(fired('under 50k')).toContain('budget_stated');
    expect(fired('above 2l')).toContain('budget_stated');
  });
});

describe('the two scripts stay in step', () => {
  /*
   * The real risk is drift: somebody renames an option in `customer-flow.ts`
   * and scoring silently stops seeing it, with no error anywhere. This asserts
   * the pairing directly rather than trusting a comment to be read.
   */
  const labelsFor = (key: string) => {
    const step = FLOW_STEPS.find((s) => s.key === key);
    if (!step) throw new Error(`no such flow step: ${key}`);
    return step.options.map((o) => o.label);
  };

  it('every budget option the bot offers is a budget signal', () => {
    for (const label of labelsFor('budget')) {
      expect(fired(label)).toContain('budget_stated');
    }
  });

  it('the bot\'s near-term timelines read as urgency, and the far ones do not', () => {
    const labels = labelsFor('timeline');
    const near = labels.filter((l) => /7 days|this month/i.test(l));
    const far = labels.filter((l) => !/7 days|this month/i.test(l));
    expect(near.length).toBeGreaterThan(0);
    for (const label of near) expect(fired(label)).toContain('timeline_soon');
    for (const label of far) expect(fired(label)).not.toContain('timeline_soon');
  });
});
