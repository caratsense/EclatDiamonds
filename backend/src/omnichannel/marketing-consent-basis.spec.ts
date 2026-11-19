import { evaluateDeliveryPolicy } from './omnichannel-policy';

/**
 * What silence means, and what it never means.
 *
 * A broadcast of 202 customers reached nobody: 166 were refused one at a time
 * for "recorded marketing consent is required", and the database held zero
 * consent events of any kind. Under the strict reading that is correct and
 * permanent — no marketing could ever leave this tenant.
 *
 * The owner's decision, in their words: "every customer which comes to the CRM
 * already comes with marketing consent, until they explicitly tell us". Their
 * list, their relationship, their call. So the tenant declares its basis.
 *
 * The line these assertions defend is the one that is easy to lose while
 * widening a rule: a customer who said STOP is refused under BOTH bases. The
 * permissive reading decides what silence means, never what a refusal means.
 */
const send = (over: Partial<Parameters<typeof evaluateDeliveryPolicy>[0]> = {}) =>
  evaluateDeliveryPolicy({
    channel: 'whatsapp',
    purpose: 'marketing',
    consent: 'unknown',
    hasApprovedTemplate: true,
    channelDeliverable: { deliverable: true, reason: '' },
    ...over,
  });

describe('a customer who has said nothing', () => {
  it('is refused when the tenant requires an explicit grant', () => {
    const d = send({ marketingConsentBasis: 'explicit' });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.code).toBe('consent_required');
  });

  it('is refused when the tenant has not chosen a basis at all', () => {
    // A business that has never made this decision has not made it
    // permissively. The default has to be the stricter reading.
    expect(send().allowed).toBe(false);
  });

  it('is messaged when the tenant has declared the implied basis', () => {
    expect(send({ marketingConsentBasis: 'implied' }).allowed).toBe(true);
  });
});

describe('a customer who has opted out', () => {
  it('is refused under the strict basis', () => {
    const d = send({ consent: 'revoked', marketingConsentBasis: 'explicit' });
    expect(d.allowed === false && d.code).toBe('recipient_opted_out');
  });

  it('is refused under the implied basis too — STOP is STOP', () => {
    // The whole point. Widening what silence means must not widen what a
    // refusal means, or the opt-out stops working the day the setting changes.
    const d = send({ consent: 'revoked', marketingConsentBasis: 'implied' });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.code).toBe('recipient_opted_out');
  });
});

describe('a customer who granted it', () => {
  it('is messaged under either basis', () => {
    expect(send({ consent: 'granted', marketingConsentBasis: 'explicit' }).allowed).toBe(true);
    expect(send({ consent: 'granted', marketingConsentBasis: 'implied' }).allowed).toBe(true);
  });
});

describe('the basis changes nothing outside marketing', () => {
  it('still refuses a service message with no template outside the window', () => {
    const d = send({
      purpose: 'service',
      hasApprovedTemplate: false,
      lastInboundAt: new Date('2026-11-01T00:00:00Z'),
      now: new Date('2026-11-19T00:00:00Z'),
      marketingConsentBasis: 'implied',
    });
    expect(d.allowed).toBe(false);
  });

  it('still refuses when the channel has no way out', () => {
    const d = send({
      marketingConsentBasis: 'implied',
      channelDeliverable: { deliverable: false, reason: 'WhatsApp is not connected.' },
    });
    expect(d.allowed === false && d.code).toBe('channel_not_connected');
  });
});
