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

  it('says a blocked template send never reached the customer', () => {
    // 28 Nov: the client sent `newmessage` from a thread, Meta had the template
    // back under review after an edit, and the worker stopped it here. She
    // concluded from the bubble that a customer had received a literal {{1}}.
    // Nobody received anything, and the sentence now says so first.
    const text = explainDeliveryError(
      'template_unavailable: The provider reports this template as pending.',
    )!;
    expect(text).toMatch(/Nothing reached the customer/i);
  });

  it('says plainly that retrying a blocked template will not help', () => {
    // Approval is Meta's to give, so every retry until then returns this same
    // refusal. The button is still there — the sentence is what stops a shop
    // floor pressing it in a loop with a customer standing in front of them.
    const text = explainDeliveryError('template_unavailable: Not approved.')!;
    expect(text).toMatch(/trying again gives\s+the same answer/i);
    expect(text).toMatch(/approved the template/i);
  });

  it('keeps the stored sentence it was given, rather than replacing it', () => {
    // The four reasons behind this one code have different remedies — switched
    // off, never synchronised, awaiting Meta, approval gone stale. Overwriting
    // them all with one sentence would be wrong about three of them.
    expect(explainDeliveryError('template_unavailable: This template has been switched off for this connection.')).toMatch(
      /^This template has been switched off for this connection\. /,
    );
  });

  it('leaves a coded refusal it has nothing to add to exactly as it was', () => {
    // The thread strips the `code:` prefix itself. Rewriting a code we have no
    // advice for would only move that work and risk losing the sentence.
    const stored = 'content_missing: The queued message has neither text nor an attachment to send.';
    expect(explainDeliveryError(stored)).toBe(stored);
  });

  it('does not mistake a provider sentence for one of our codes', () => {
    // "HTTP 400: …" has the same colon shape. It is Meta's words, not ours, and
    // must survive whole.
    const provider = 'HTTP 400: Parameter format does not match format in template definition';
    expect(explainDeliveryError(provider)).toBe(provider);
  });

  it('has nothing to say about a message that did not fail', () => {
    expect(explainDeliveryError(null)).toBeNull();
    expect(explainDeliveryError('')).toBeNull();
  });
});
