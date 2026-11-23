import { DEFAULT_LEAD_FORMAT } from '../common/export-formats';
import { type LeadRecord, leadRow, transactionChannel } from './lead-export.service';

/**
 * What goes in each cell of the client's Master Leads sheet.
 *
 * Every case below is one she reconciles by hand against her own workbook, and
 * every failure mode is a file that LOOKS correct: a Summary tab whose
 * non-purchase count includes leads still being worked, or a Sales Rs column
 * that adds up to more than the shop took.
 */
function lead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    ref: 'L-1001',
    customerName: 'Shweta Maheswari',
    phone: '+919647815195',
    source: 'walk_in',
    stage: 'inquiry',
    outcome: 'open',
    value: null,
    createdAt: new Date('2026-08-04T06:30:00.000Z'),
    closedAt: null,
    lastActivity: null,
    location: 'Mumbai',
    interest: 'Diamond ring',
    attributes: null,
    store: { name: 'Bandra', timezone: 'Asia/Kolkata' },
    owner: { name: 'Priyanka' },
    ...overrides,
  };
}

describe('Status (Purchase / Non purchase)', () => {
  it('is blank while the lead is still open', () => {
    /*
     * Her column has THREE states and the third is empty. A lead being worked is
     * neither a purchase nor a non-purchase; writing "Non-purchase" today would
     * overstate every branch's loss rate in her Summary tab, which counts this
     * column with COUNTIFS.
     */
    expect(leadRow(lead({ outcome: 'open' }), 0).purchaseStatus).toBe('');
  });

  it('says Purchase for a won lead and Non-purchase for a lost one', () => {
    expect(leadRow(lead({ outcome: 'won' }), 0).purchaseStatus).toBe('Purchase');
    expect(leadRow(lead({ outcome: 'lost' }), 0).purchaseStatus).toBe('Non-purchase');
  });

  it('uses her hyphenation, which her Summary formula matches on', () => {
    // `COUNTIFS('Master Sheet'!$J:$J, F$1)` compares the cell to the heading
    // text. "Non purchase" would count zero and look like a quiet month.
    expect(leadRow(lead({ outcome: 'lost' }), 0).purchaseStatus).toBe('Non-purchase');
  });
});

describe('Sales Rs versus Value of Purchase Made', () => {
  const amount = { toString: () => '125000', valueOf: () => 125000 } as never;

  it('fills Value for any outcome, so the opportunity size is never lost', () => {
    expect(leadRow(lead({ value: amount, outcome: 'open' }), 0).value).toBe(125000);
  });

  it('fills Sales Rs ONLY on a won lead', () => {
    // These are two different columns in her workbook and the Summary tab SUMIFS
    // the second one. Filling it for an open lead would book revenue on a sale
    // that has not happened.
    expect(leadRow(lead({ value: amount, outcome: 'open' }), 0).salesValue).toBe('');
    expect(leadRow(lead({ value: amount, outcome: 'lost' }), 0).salesValue).toBe('');
    expect(leadRow(lead({ value: amount, outcome: 'won' }), 0).salesValue).toBe(125000);
  });

  it('leaves both blank rather than writing a zero', () => {
    // A zero in a money column is a real figure; a blank is "nobody said".
    const row = leadRow(lead({ value: null, outcome: 'won' }), 0);
    expect(row.value).toBe('');
    expect(row.salesValue).toBe('');
  });
});

describe('Sale Date', () => {
  it('is blank unless the lead was won', () => {
    const closed = new Date('2026-09-10T04:00:00.000Z');
    expect(leadRow(lead({ outcome: 'lost', closedAt: closed }), 0).saleDate).toBe('');
    expect(leadRow(lead({ outcome: 'won', closedAt: closed }), 0).saleDate).not.toBe('');
  });
});

describe('Transaction channel (Website, Store)', () => {
  it('names only the two the source actually tells us', () => {
    expect(transactionChannel('website')).toBe('Website');
    expect(transactionChannel('walk_in')).toBe('Store');
  });

  it('stays blank for a source that says nothing about where the sale happened', () => {
    /*
     * A Meta ad says where the lead CAME FROM, not where it closed. Her column
     * has two values in it; inventing a third would put a number into a count
     * she reconciles by hand.
     */
    for (const source of ['meta_ads', 'instagram', 'whatsapp', 'phone', 'referral', 'imported']) {
      expect(transactionChannel(source)).toBe('');
    }
  });
});

describe('the walk-in register’s own answers', () => {
  it('reads customer type, category and occasion off the most recent visit', () => {
    // These three are asked on the walk-in form and stored in the visit's
    // metadata — there is nowhere else on a lead they could come from.
    const row = leadRow(
      lead({
        visits: [
          {
            metadata: { customerType: 'Repeat', productCategory: 'Rings', occasion: 'Wedding' },
            store: { name: 'Indore' },
          },
        ],
      }),
      0,
    );
    expect(row.customerType).toBe('Repeat');
    expect(row.productCategory).toBe('Rings');
    expect(row.occasion).toBe('Wedding');
    expect(row.storeVisited).toBe('Indore');
  });

  it('leaves them blank for a lead that never came in', () => {
    // Blank, not "N/A" — "N/A" reads as an answer somebody gave.
    const row = leadRow(lead({ visits: [], party: null }), 0);
    expect(row.customerType).toBe('');
    expect(row.productCategory).toBe('');
    expect(row.occasion).toBe('');
    expect(row.storeVisited).toBe('');
  });

  it('ignores a metadata value that is not text', () => {
    // The register's metadata is free-form JSON; a number or an object in one of
    // these keys must not reach a cell as "[object Object]".
    const row = leadRow(
      lead({ visits: [{ metadata: { customerType: 7 }, store: null }] }),
      0,
    );
    expect(row.customerType).toBe('');
  });

  it('answers from the same visits the Visits count counts', () => {
    /*
     * The RULE, not the plumbing: a row that says the customer has been in may
     * not leave the four register columns blank when one of those very visits
     * carries the answers.
     *
     * It was broken in exactly that way — the count came from the customer
     * while the answers came from check-ins filed against this lead row, and in
     * the live database not one check-in of 622 carries a `leadId`. So every
     * row with a visit count showed it beside four blanks, which the client
     * reads as data we failed to capture rather than as a join that missed.
     */
    const row = leadRow(
      lead({
        visits: [],
        party: {
          _count: { checkIns: 3 },
          checkIns: [
            {
              metadata: { customerType: 'Repeat', productCategory: 'Rings', occasion: 'Wedding' },
              store: { name: 'Indore' },
            },
          ],
        },
      }),
      0,
    );
    expect(row.visitCount).toBe(3);
    expect(row.storeVisited).toBe('Indore');
    expect(row.customerType).toBe('Repeat');
    expect(row.productCategory).toBe('Rings');
    expect(row.occasion).toBe('Wedding');
  });

  it('prefers the visit filed against this enquiry over the customer’s latest', () => {
    // A check-in attached to this enquiry describes THIS enquiry's visit. The
    // customer's own latest may belong to a different enquiry entirely — it is
    // the fallback, not the answer.
    const row = leadRow(
      lead({
        visits: [{ metadata: { customerType: 'New' }, store: { name: 'Bandra' } }],
        party: {
          _count: { checkIns: 4 },
          checkIns: [{ metadata: { customerType: 'Repeat' }, store: { name: 'Indore' } }],
        },
      }),
      0,
    );
    expect(row.customerType).toBe('New');
    expect(row.storeVisited).toBe('Bandra');
  });
});

describe('No.', () => {
  it('counts from 1 down the sheet, matching her first column', () => {
    expect(leadRow(lead(), 0).serial).toBe(1);
    expect(leadRow(lead(), 41).serial).toBe(42);
  });
});

describe('the default format and the builder agree', () => {
  it('fills every one of her twenty columns with something defined', () => {
    /*
     * The bug this catches: a column in the default format whose field the
     * builder never writes. It would reach a person as a heading with an empty
     * column under it, discovered by whoever the file was forwarded to rather
     * than by us.
     */
    const row = leadRow(
      lead({
        outcome: 'won',
        closedAt: new Date('2026-09-10T04:00:00.000Z'),
        attributes: { campaignName: 'Diwali Udaipur' },
        visits: [{ metadata: { customerType: 'New' }, store: { name: 'Udaipur' } }],
        notes: [{ text: 'Called, coming Saturday' }],
      }),
      0,
    );
    for (const column of DEFAULT_LEAD_FORMAT) {
      expect(row[column.field]).toBeDefined();
    }
  });
});
