/**
 * The daily-report questionnaire, exercised without a database or WhatsApp.
 *
 * Named `.e2e-spec.ts` only because that is what the runner matches; nothing
 * here touches a container.
 *
 * These exist because of a real report filed from MUMBAI BANDRA on 4 Oct 2026
 * that read:
 *
 *     Advance received: ₹0
 *     Cash ₹0 · Card ₹0 · UPI ₹3,00,000
 *
 * Nothing had come in, and the bot asked for the split anyway — three
 * questions whose premise had already failed — then took ₹3,00,000 at face
 * value and wrote it to the report. Both halves of that are tested below: the
 * questions are no longer put, and a split that exceeds what was received is
 * no longer accepted.
 */
import {
  DSR_FIELDS,
  fillSkipped,
  moneyReceived,
  nextAskableStep,
  paymentSplitError,
  promptFor,
  shouldAsk,
  summarise,
  type DsrDraft,
} from '../src/whatsapp-bot/dsr-flow';

const field = (key: string) => {
  const f = DSR_FIELDS.find((x) => x.key === key);
  if (!f) throw new Error(`no such field: ${key}`);
  return f;
};
const indexOf = (key: string) => DSR_FIELDS.findIndex((x) => x.key === key);

/** A day where nothing was sold and nothing was taken. */
const EMPTY_DAY: DsrDraft = {
  walkIns: 0,
  seriousEnquiries: 2,
  deliveredBilled: 0,
  bookingsNew: 0,
  advanceReceived: 0,
};

describe('DSR flow — a follow-up is only asked when its premise holds', () => {
  it('does not ask for the payment split on a day nothing came in', () => {
    for (const key of ['cash', 'card', 'upi']) {
      expect(shouldAsk(field(key), EMPTY_DAY)).toBe(false);
    }
  });

  it('does ask for the split when money was actually taken', () => {
    const withAdvance = { ...EMPTY_DAY, advanceReceived: 300000 };
    for (const key of ['cash', 'card', 'upi']) {
      expect(shouldAsk(field(key), withAdvance)).toBe(true);
    }
  });

  it('asks for the split when the day was billed but took no advance', () => {
    // The reason the premise is billed PLUS advance rather than the advance
    // alone: a day with sales and no advance still has a payment mix.
    const billedOnly = { ...EMPTY_DAY, deliveredBilled: 500000 };
    expect(moneyReceived(billedOnly)).toBe(500000);
    expect(shouldAsk(field('cash'), billedOnly)).toBe(true);
  });

  it('skips straight from advance to old gold on an empty day', () => {
    const next = nextAskableStep(EMPTY_DAY, indexOf('advanceReceived') + 1);
    expect(DSR_FIELDS[next].key).toBe('oldGoldWtG');
  });

  it('does not ask what the old gold was worth when none was taken', () => {
    const noGold = { ...EMPTY_DAY, oldGoldWtG: null };
    expect(shouldAsk(field('oldGoldValue'), noGold)).toBe(false);
    // And the questionnaire ends there rather than asking for a value.
    expect(nextAskableStep(noGold, indexOf('oldGoldWtG') + 1)).toBe(DSR_FIELDS.length);
  });

  it('asks the value once some old gold is recorded', () => {
    expect(shouldAsk(field('oldGoldValue'), { ...EMPTY_DAY, oldGoldWtG: 12.5 })).toBe(true);
  });
});

describe('DSR flow — a skipped question still produces a value', () => {
  it('writes zero for a required field that was never asked', () => {
    const filled = fillSkipped({ ...EMPTY_DAY, oldGoldWtG: null });
    // Zero, not null: nothing was taken in cash, which is a fact, not a gap.
    expect(filled.cash).toBe(0);
    expect(filled.card).toBe(0);
    expect(filled.upi).toBe(0);
  });

  it('leaves an unasked optional field null', () => {
    const filled = fillSkipped({ ...EMPTY_DAY, oldGoldWtG: null });
    // "No old gold" is honestly nothing, not zero rupees of something.
    expect(filled.oldGoldValue).toBeNull();
  });

  it('never overwrites an answer somebody actually gave', () => {
    const answered = { ...EMPTY_DAY, advanceReceived: 50000, cash: 50000, card: 0, upi: 0 };
    expect(fillSkipped(answered).cash).toBe(50000);
  });

  it('summarises an empty day without inventing a payment', () => {
    const text = summarise(fillSkipped({ ...EMPTY_DAY, oldGoldWtG: null }), 'MUMBAI BANDRA', '4 Oct 2026');
    expect(text).toContain('Advance received: ₹0');
    expect(text).toContain('Cash ₹0');
    expect(text).not.toContain('3,00,000');
  });
});

describe('DSR flow — the split has to reconcile with what came in', () => {
  it('rejects the exact report that was filed on 4 Oct', () => {
    const bad = { ...EMPTY_DAY, cash: 0, card: 0, upi: 300000 };
    const complaint = paymentSplitError(bad);
    expect(complaint).toBeTruthy();
    // The message has to name both sides, or the person cannot tell which
    // number they got wrong.
    expect(complaint).toContain('₹3,00,000');
    expect(complaint).toContain('₹0');
  });

  it('accepts a split that matches what came in', () => {
    const good = { ...EMPTY_DAY, advanceReceived: 100000, cash: 40000, card: 60000, upi: 0 };
    expect(paymentSplitError(good)).toBeNull();
  });

  it('accepts a split smaller than what came in', () => {
    // Part of a bill can go unpaid on the day; only MORE than came in is wrong.
    const partial = { ...EMPTY_DAY, deliveredBilled: 500000, cash: 100000, card: 0, upi: 0 };
    expect(paymentSplitError(partial)).toBeNull();
  });
});

describe('DSR flow — the counter reflects the questions actually asked', () => {
  it('does not promise ten questions on a day that only has six', () => {
    const prompt = promptFor(field('oldGoldWtG'), indexOf('oldGoldWtG'), EMPTY_DAY);
    // Walk-ins, enquiries, billed, bookings, advance, then old gold: six. The
    // split is skipped, and so is the old-gold VALUE — at this moment no gold
    // has been reported, so on what is known now this is the last question.
    expect(prompt).toContain('6/6');
    expect(prompt).not.toContain('/10');
  });

  it('grows the total when an answer opens a follow-up', () => {
    /*
     * The documented trade-off, pinned down. The denominator is the best
     * estimate from what is known now, so reporting some old gold turns the
     * six-question day into a seven-question one. A fixed denominator would
     * be wrong for every report containing a skip; a moving one is only ever
     * wrong about the future.
     */
    const withGold = { ...EMPTY_DAY, oldGoldWtG: 12.5 };
    expect(promptFor(field('oldGoldValue'), indexOf('oldGoldValue'), withGold)).toContain('7/7');
  });

  it('still counts all ten on a day where every question applies', () => {
    const busy: DsrDraft = { deliveredBilled: 500000, advanceReceived: 100000, oldGoldWtG: 10 };
    expect(promptFor(field('upi'), indexOf('upi'), busy)).toContain('/10');
  });

  it('tells the reporter which answers may be skipped', () => {
    expect(promptFor(field('oldGoldWtG'), indexOf('oldGoldWtG'), EMPTY_DAY)).toContain('skip');
    expect(promptFor(field('walkIns'), 0, EMPTY_DAY)).toContain('*0*');
  });
});
