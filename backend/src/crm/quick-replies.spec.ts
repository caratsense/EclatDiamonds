import {
  CUSTOMER_CARE_WINDOW_MS,
  QUICK_REPLY_PLACEHOLDERS,
  fillPlaceholders,
  insideCustomerCareWindow,
  kindUsableNow,
  unknownPlaceholders,
} from './quick-replies';

/**
 * The three quick replies that shipped hardcoded in `conversations/page.tsx`
 * are now rows, and these are the rules that make a row safe to put in front
 * of a customer.
 *
 * The one this file exists for is the last describe block: the chip row used to
 * render only when the 24-hour window was open, so the single state the client
 * actually asked about — "if anybody missed their message so they can contact
 * after that" — was the one state with no shortcuts at all.
 */
describe('fillPlaceholders', () => {
  const subject = { customerName: 'Priya Shah', branchName: 'Bandra', agentName: 'Rahul Mehta' };

  it('fills the two the hardcoded chips already used', () => {
    expect(
      fillPlaceholders(
        'Hello {customer}! Our {branch} showroom is open 10:30 AM to 8:30 PM.',
        subject,
      ),
    ).toBe('Hello Priya Shah! Our Bandra showroom is open 10:30 AM to 8:30 PM.');
  });

  it('fills a first name and the salesperson from their full names', () => {
    expect(fillPlaceholders('Hi {first_name}, {me} here.', subject)).toBe('Hi Priya, Rahul here.');
  });

  it('uses the stand-in when the value is missing, never an empty gap', () => {
    // An ad click with no name recorded is the ordinary case, not an edge one.
    expect(fillPlaceholders('Hello {customer}!', { customerName: null })).toBe('Hello there!');
    expect(fillPlaceholders('Our {branch} is open.', {})).toBe('Our our showroom is open.');
  });

  it('flattens a pasted name rather than sending the line break in it', () => {
    expect(fillPlaceholders('Hi {customer}.', { customerName: ' Priya \n  Shah ' })).toBe(
      'Hi Priya Shah.',
    );
  });

  it('never leaves a raw placeholder in the composer', () => {
    /*
     * The failure this prevents is specific: a `{discount}` left in the box
     * tells the salesperson the feature is broken at the moment they are
     * mid-sentence with somebody in front of them, and the worst version sends
     * it to the customer. Saving refuses an unknown token, so this is only
     * reachable by a row written by hand — and it still must not leak.
     */
    const filled = fillPlaceholders('Here is {discount} for you, {customer}.', subject);
    expect(filled).not.toContain('{');
    expect(filled).toBe('Here is for you, Priya Shah.');
  });

  it('closes the gap a removed token leaves, including before punctuation', () => {
    expect(fillPlaceholders('Thanks {nothing} .', {})).toBe('Thanks.');
  });
});

describe('unknownPlaceholders', () => {
  it('names only what this release cannot fill', () => {
    expect(unknownPlaceholders('Hi {customer}, your {order_number} is ready.')).toEqual([
      'order_number',
    ]);
  });

  it('accepts every documented placeholder', () => {
    const body = QUICK_REPLY_PLACEHOLDERS.map((p) => `{${p.token}}`).join(' ');
    expect(unknownPlaceholders(body)).toEqual([]);
  });

  it('reports a token once however often it appears', () => {
    expect(unknownPlaceholders('{foo} and {foo} again')).toEqual(['foo']);
  });
});

describe('insideCustomerCareWindow', () => {
  const now = new Date('2026-11-23T10:00:00.000Z');

  it('is open just inside 24 hours and closed just outside it', () => {
    expect(
      insideCustomerCareWindow(new Date(now.getTime() - CUSTOMER_CARE_WINDOW_MS + 60_000), now),
    ).toBe(true);
    expect(
      insideCustomerCareWindow(new Date(now.getTime() - CUSTOMER_CARE_WINDOW_MS - 1), now),
    ).toBe(false);
  });

  it('is closed when the customer has never written', () => {
    // No inbound message means no window ever opened — not a window of unknown age.
    expect(insideCustomerCareWindow(null, now)).toBe(false);
  });

  it('is closed for a timestamp in the future', () => {
    // A clock-skewed webhook must not be read as a window that has 24 more hours
    // to run: failing closed here costs a template, failing open costs a send
    // WhatsApp refuses.
    expect(insideCustomerCareWindow(new Date(now.getTime() + 60_000), now)).toBe(false);
  });
});

describe('kindUsableNow', () => {
  it('offers free text only inside the window', () => {
    expect(kindUsableNow('free_text', true)).toBe(true);
    expect(kindUsableNow('free_text', false)).toBe(false);
  });

  it('offers a template-backed reply at any time', () => {
    /*
     * The whole point of the client's ask. A template is the only thing that
     * reaches somebody more than 24 hours after they last wrote, so the chip
     * row outside the window is exactly the template-backed ones — where
     * before this it was nothing.
     */
    expect(kindUsableNow('template', false)).toBe(true);
    expect(kindUsableNow('template', true)).toBe(true);
  });
});
