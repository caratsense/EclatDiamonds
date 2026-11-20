import { explainDeliveryError } from './whatsapp-delivery-errors';

/**
 * The client's question, on seeing her broadcast report: twenty-two customers
 * marked dead against "Provider error 131049" — they have a number and they
 * have consent, so why did it fail?
 *
 * A reason nobody can act on is not a reason. What is pinned here is that each
 * sentence says whose decision it was, because "Meta declined" and "our
 * template is wrong" are both failures and they are not the same news.
 */

describe('explaining a delivery failure', () => {
  it('says Meta declined, and that there is nothing to fix', () => {
    const text = explainDeliveryError('Provider error 131049')!;
    expect(text).toMatch(/Meta chose not to deliver/i);
    expect(text).toMatch(/nothing to fix/i);
  });

  it('says a hold-out number is Meta’s choice, not ours', () => {
    expect(explainDeliveryError('Provider error 130472')).toMatch(/Meta test group/i);
  });

  it('owns the failures that are ours', () => {
    // The opposite news, and it has to read that way: a template we sent wrong
    // is work for us, not a customer to write off.
    expect(explainDeliveryError('Provider error 132012')).toMatch(/ours to fix/i);
  });

  it('explains every code when the provider reports more than one', () => {
    const text = explainDeliveryError('Provider error 131049, 130472')!;
    expect(text).toMatch(/Meta chose not to deliver/i);
    expect(text).toMatch(/Meta test group/i);
  });

  it('still says what happened for a code it does not know', () => {
    // The worst outcome is a blank where a reason was. An unknown code must
    // still distinguish "they declined" from "we never sent it".
    const text = explainDeliveryError('Provider error 999999')!;
    expect(text).toContain('999999');
    expect(text).toMatch(/It was sent; they declined/i);
  });

  it('leaves our own plain sentences exactly as they are', () => {
    const ours = 'That is not a usable WhatsApp number.';
    expect(explainDeliveryError(ours)).toBe(ours);
  });

  it('has nothing to say about a message that did not fail', () => {
    expect(explainDeliveryError(null)).toBeNull();
    expect(explainDeliveryError('')).toBeNull();
  });
});
