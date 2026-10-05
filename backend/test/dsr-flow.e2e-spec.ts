/**
 * The daily-report questionnaire, exercised without a database or WhatsApp.
 *
 * Named `.e2e-spec.ts` only because that is what the runner matches; nothing
 * here touches a container.
 *
 * Two production faults drive these tests.
 *
 * The first is a report filed from MUMBAI BANDRA on 4 Oct 2026 reading
 * "Advance received: ₹0" beside "UPI ₹3,00,000" — the bot asked for the
 * payment split after everything came back zero, then took ₹3,00,000 at face
 * value.
 *
 * The second is quieter and worse. The questionnaire asked ten things; the DSR
 * sheet it becomes has around twenty. Conversions, open and closed bookings,
 * the entire customised-sale payment split and the remark were never asked, so
 * every WhatsApp-filed report carried them as zeros — and a default zero is
 * indistinguishable from a counted one once it is in the column.
 */
import {
  DSR_FIELDS,
  FOOTFALL,
  REMARK,
  TABLE_A,
  TABLE_B,
  fillSkipped,
  nextAskableStep,
  paymentSplitError,
  promptFor,
  sectionOf,
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

/** A day where nobody bought anything. */
const EMPTY_DAY: DsrDraft = {
  walkIns: 4,
  seriousEnquiries: 2,
  conversions: 0,
  deliveredBilled: 0,
  bookingsNew: 0,
  bookingsOpen: 0,
  bookingsClosed: 0,
  advanceReceived: 0,
};

describe('DSR covers every column the sheet prints', () => {
  /*
   * The sheet is the contract. These keys are the ones `dsr-sheet.ts` reads to
   * draw the document and the ones `DailyReport` stores, so a field missing
   * here is a column filled with a default that reads as a measurement.
   */
  const SHEET_COLUMNS = [
    'walkIns', 'seriousEnquiries', 'conversions',
    'deliveredBilled', 'cash', 'card', 'upi', 'oldGoldWtG', 'oldGoldValue',
    'bookingsNew', 'bookingsOpen', 'bookingsClosed', 'advanceReceived',
    'customCash', 'customCard', 'customUpi', 'customBankTransfer',
    'customGoldWtG', 'customGoldValue',
    'remark',
  ];

  it('asks for every column the sheet prints', () => {
    const asked = new Set(DSR_FIELDS.map((f) => f.key));
    for (const key of SHEET_COLUMNS) expect(asked).toContain(key);
  });

  it('does not ask for a figure the system derives', () => {
    // "Closing Booking" is computed by the reporting service. Asking a person
    // for it invites their arithmetic to disagree with the sheet's.
    expect(DSR_FIELDS.map((f) => f.key)).not.toContain('bookingsClosing');
  });
});

describe('a follow-up is only asked when its premise holds', () => {
  it('does not ask the counter-sale split when nothing was sold at the counter', () => {
    for (const key of ['cash', 'card', 'upi', 'oldGoldWtG']) {
      expect(shouldAsk(field(key), EMPTY_DAY)).toBe(false);
    }
  });

  it('asks the counter-sale split once there is a counter sale', () => {
    const sold = { ...EMPTY_DAY, deliveredBilled: 500000 };
    for (const key of ['cash', 'card', 'upi']) {
      expect(shouldAsk(field(key), sold)).toBe(true);
    }
  });

  it('does not ask the customised split when nothing was received against bookings', () => {
    for (const key of ['customCash', 'customCard', 'customUpi', 'customBankTransfer']) {
      expect(shouldAsk(field(key), EMPTY_DAY)).toBe(false);
    }
  });

  it('asks the customised split once money was received against bookings', () => {
    const received = { ...EMPTY_DAY, advanceReceived: 100000 };
    for (const key of ['customCash', 'customCard', 'customUpi', 'customBankTransfer']) {
      expect(shouldAsk(field(key), received)).toBe(true);
    }
  });

  it('never asks what gold was worth when none was taken', () => {
    expect(shouldAsk(field('oldGoldValue'), EMPTY_DAY)).toBe(false);
    expect(shouldAsk(field('customGoldValue'), EMPTY_DAY)).toBe(false);
  });

  it('asks the gold value once a weight is recorded, in either table', () => {
    expect(shouldAsk(field('oldGoldValue'), { ...EMPTY_DAY, oldGoldWtG: 12.5 })).toBe(true);
    expect(shouldAsk(field('customGoldValue'), { ...EMPTY_DAY, customGoldWtG: 8 })).toBe(true);
  });

  it('skips a whole table on a quiet day', () => {
    // From the counter-sale value straight to the bookings block.
    const next = nextAskableStep(EMPTY_DAY, indexOf('deliveredBilled') + 1);
    expect(DSR_FIELDS[next].key).toBe('bookingsNew');
  });
});

describe('a skipped question still produces a value', () => {
  it('writes zero for a required field that was never asked', () => {
    const filled = fillSkipped(EMPTY_DAY);
    for (const key of ['cash', 'upi', 'customCash', 'customBankTransfer']) {
      expect(filled[key]).toBe(0);
    }
  });

  it('leaves an unasked optional field null', () => {
    const filled = fillSkipped(EMPTY_DAY);
    // "No old gold" is honestly nothing, not zero grams of something.
    expect(filled.oldGoldWtG).toBeNull();
    expect(filled.customGoldValue).toBeNull();
  });

  it('never overwrites an answer somebody actually gave', () => {
    const answered = { ...EMPTY_DAY, deliveredBilled: 50000, cash: 50000, card: 0, upi: 0 };
    expect(fillSkipped(answered).cash).toBe(50000);
  });
});

describe('each table reconciles against its own total', () => {
  it('rejects the exact report filed on 4 Oct', () => {
    const bad = { ...EMPTY_DAY, cash: 0, card: 0, upi: 300000 };
    const complaint = paymentSplitError(bad, 'A');
    expect(complaint).toBeTruthy();
    expect(complaint).toContain('₹3,00,000');
  });

  it('will not let a customised overstatement hide behind counter-sale headroom', () => {
    /*
     * The reason the two tables are checked separately rather than summed: ₹5L
     * of counter sale would otherwise absorb a ₹1L overstatement against
     * bookings, and the store reconciles the two documents independently.
     */
    const draft = {
      ...EMPTY_DAY,
      deliveredBilled: 500000,
      advanceReceived: 0,
      customCash: 100000,
    };
    expect(paymentSplitError(draft, 'B')).toBeTruthy();
  });

  it('accepts a split that matches', () => {
    const good = { ...EMPTY_DAY, deliveredBilled: 100000, cash: 40000, card: 60000, upi: 0 };
    expect(paymentSplitError(good, 'A')).toBeNull();
  });

  it('accepts a split smaller than the total, since part of a bill can go unpaid', () => {
    const partial = { ...EMPTY_DAY, deliveredBilled: 500000, cash: 100000 };
    expect(paymentSplitError(partial, 'A')).toBeNull();
  });

  it('counts old gold as a payment, because the sheet does', () => {
    // The sheet's Table A total is cash + card + UPI + gold value.
    const draft = { ...EMPTY_DAY, deliveredBilled: 100000, cash: 50000, oldGoldValue: 80000 };
    expect(paymentSplitError(draft, 'A')).toBeTruthy();
  });
});

describe('the reporter is told which table they are filling', () => {
  it('gives each block the sheet\'s own heading', () => {
    expect(sectionOf(field('walkIns'), indexOf('walkIns'))).toBe(FOOTFALL);
    expect(sectionOf(field('cash'), indexOf('cash'))).toBe(TABLE_A);
    expect(sectionOf(field('customCash'), indexOf('customCash'))).toBe(TABLE_B);
    expect(sectionOf(field('remark'), indexOf('remark'))).toBe(REMARK);
  });

  it('separates the two cash questions, which are otherwise identical', () => {
    // Same words, different column of a signed document.
    expect(field('cash').prompt).toBe(field('customCash').prompt);
    expect(sectionOf(field('cash'), indexOf('cash'))).not.toBe(
      sectionOf(field('customCash'), indexOf('customCash')),
    );
  });
});

describe('the counter reflects the questions actually asked', () => {
  it('does not promise twenty questions on a day that has nine', () => {
    const prompt = promptFor(field('remark'), indexOf('remark'), EMPTY_DAY);
    expect(prompt).not.toContain('/20');
    expect(prompt).toContain('9/9');
  });

  it('tells the reporter which answers may be skipped', () => {
    expect(promptFor(field('remark'), indexOf('remark'), EMPTY_DAY)).toContain('skip');
    expect(promptFor(field('walkIns'), 0, EMPTY_DAY)).toContain('*0*');
  });
});

describe('the summary reads like the sheet', () => {
  it('shows the two tables separately', () => {
    const text = summarise(fillSkipped(EMPTY_DAY), 'MUMBAI BANDRA', '5 Oct 2026');
    expect(text).toContain('Counter sale');
    expect(text).toContain('Customised sale');
  });

  it('does not invent a payment on a day nothing came in', () => {
    const text = summarise(fillSkipped(EMPTY_DAY), 'MUMBAI BANDRA', '5 Oct 2026');
    expect(text).not.toContain('3,00,000');
  });

  it('carries the remark through in the reporter\'s own words', () => {
    const withRemark = { ...fillSkipped(EMPTY_DAY), remark: 'Power cut from 4pm' };
    expect(summarise(withRemark, 'MUMBAI BANDRA', '5 Oct 2026')).toContain('Power cut from 4pm');
  });
});
