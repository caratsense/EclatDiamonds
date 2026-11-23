import {
  businessSenderNameFrom,
  signAsBusiness,
  stripOutboundSignature,
} from './outbound-signature';

/**
 * The rule under test is "the customer sees the BUSINESS, and the CRM sees what
 * was said" — including for the thousands of replies already stored with the
 * old per-sender signature.
 */
describe('outbound signature', () => {
  describe('businessSenderNameFrom', () => {
    it('prefers the tenant’s configured display name', () => {
      expect(
        businessSenderNameFrom({ branding: { displayName: 'Nibhana' } }, 'Nibhana Jewels Pvt Ltd'),
      ).toBe('Nibhana');
    });

    it('falls back to the organisation name when branding has none', () => {
      expect(businessSenderNameFrom({ featureProfile: {} }, 'Nibhana')).toBe('Nibhana');
      expect(businessSenderNameFrom(null, 'Nibhana')).toBe('Nibhana');
      expect(businessSenderNameFrom({ branding: { displayName: '   ' } }, 'Nibhana')).toBe('Nibhana');
    });

    it('falls back rather than throwing on a malformed settings bag', () => {
      expect(businessSenderNameFrom('not json at all', 'Nibhana')).toBe('Nibhana');
      expect(businessSenderNameFrom(['branding'], 'Nibhana')).toBe('Nibhana');
      expect(businessSenderNameFrom({ branding: { displayName: 42 } }, 'Nibhana')).toBe('Nibhana');
    });

    it('reads a settings bag the driver handed back as a string', () => {
      expect(
        businessSenderNameFrom(JSON.stringify({ branding: { displayName: 'Nibhana' } }), 'Org'),
      ).toBe('Nibhana');
    });

    // A tenant whose name is somehow blank must not be signed `**` — the caller
    // treats '' as "do not sign".
    it('is empty when there is no name anywhere', () => {
      expect(businessSenderNameFrom({}, '   ')).toBe('');
    });
  });

  describe('signAsBusiness', () => {
    it('signs a WhatsApp reply with the business, never the sender', () => {
      expect(signAsBusiness('Yes, that is in stock.', 'Nibhana', 'whatsapp')).toBe(
        '*Nibhana*\nYes, that is in stock.',
      );
    });

    it('leaves other channels alone, because * is WhatsApp markup', () => {
      expect(signAsBusiness('Yes, that is in stock.', 'Nibhana', 'instagram')).toBe(
        'Yes, that is in stock.',
      );
    });

    it('leaves an unsigned message unsigned when there is no text or no name', () => {
      expect(signAsBusiness(null, 'Nibhana', 'whatsapp')).toBeNull();
      expect(signAsBusiness('Yes.', '', 'whatsapp')).toBe('Yes.');
      expect(signAsBusiness('Yes.', '   ', 'whatsapp')).toBe('Yes.');
    });
  });

  describe('stripOutboundSignature', () => {
    const businessName = 'Nibhana';

    it('strips the new business signature', () => {
      expect(stripOutboundSignature('*Nibhana*\nYes, that is in stock.', [businessName, 'Ayushi'])).toBe(
        'Yes, that is in stock.',
      );
    });

    /*
     * THE REGRESSION THIS GUARDS. Every reply stored before the change carries
     * the staff account's name, and 'Head Office' is a real account name in
     * production. Strip only the new shape and the inbox preview of every one of
     * those threads becomes the words "Head Office".
     */
    it('still strips the old per-sender signature already in the database', () => {
      expect(
        stripOutboundSignature('*Head Office*\nYour order is ready.', [businessName, 'Head Office']),
      ).toBe('Your order is ready.');
    });

    it('leaves a body whose first line is the agent’s own bold text', () => {
      expect(
        stripOutboundSignature('*Diwali offer*\nGold at today’s rate.', [businessName, 'Head Office']),
      ).toBe('*Diwali offer*\nGold at today’s rate.');
    });

    it('removes at most one line — a message is signed once', () => {
      expect(
        stripOutboundSignature('*Nibhana*\n*Nibhana*\nTwice.', [businessName, businessName]),
      ).toBe('*Nibhana*\nTwice.');
    });

    it('ignores empty and missing candidates instead of matching **', () => {
      expect(stripOutboundSignature('**\nOdd.', [null, undefined, '', '  '])).toBe('**\nOdd.');
    });

    it('leaves the body of an unsigned message untouched', () => {
      expect(stripOutboundSignature('Yes, that is in stock.', [businessName, 'Ayushi'])).toBe(
        'Yes, that is in stock.',
      );
    });

    /*
     * A sender renamed since they sent cannot be matched, and we do not guess:
     * the stored body is the transcript, and an unmatched signature stays
     * visible rather than being removed by a looser rule that would also eat
     * real bold text.
     */
    it('leaves a signature naming somebody not in the candidate list', () => {
      expect(stripOutboundSignature('*Priya (left)*\nSent earlier.', [businessName, 'Priya K'])).toBe(
        '*Priya (left)*\nSent earlier.',
      );
    });
  });
});
