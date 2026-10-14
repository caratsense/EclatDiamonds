import { normalizeCustomerPhone, normalizeIndianMobile, isValidEmail } from '../src/common/contact.util';

/**
 * Recipient validation for outbound reports (WhatsApp / email). Pure logic —
 * pins that a number is NOT "valid" just because digits can be salvaged from it
 * (letters/symbols reject), and that valid formats normalise to a canonical
 * 10-digit Indian mobile.
 */
describe('normalizeIndianMobile', () => {
  it('accepts a clean 10-digit mobile', () => {
    expect(normalizeIndianMobile('9876500000')).toBe('9876500000');
  });

  it('accepts and strips common formatting (+91, spaces, hyphens, parens)', () => {
    expect(normalizeIndianMobile('+91 98765-00000')).toBe('9876500000');
    expect(normalizeIndianMobile('(0)9876500000')).toBe('9876500000');
    expect(normalizeIndianMobile('09876500000')).toBe('9876500000');
  });

  it('REJECTS letters instead of salvaging digits', () => {
    expect(normalizeIndianMobile('9876a500000')).toBeNull();
    expect(normalizeIndianMobile('call me 9876500000')).toBeNull();
  });

  it('REJECTS stray symbols', () => {
    expect(normalizeIndianMobile('9876#500000')).toBeNull();
    expect(normalizeIndianMobile('9876500000@x')).toBeNull();
  });

  it('REJECTS too short / too long', () => {
    expect(normalizeIndianMobile('98765')).toBeNull();
    expect(normalizeIndianMobile('98765000001234')).toBeNull();
  });

  it('REJECTS a number not starting 6-9 (not an Indian mobile)', () => {
    expect(normalizeIndianMobile('1234500000')).toBeNull();
    expect(normalizeIndianMobile('5876500000')).toBeNull();
  });

  it('REJECTS empty', () => {
    expect(normalizeIndianMobile('')).toBeNull();
    expect(normalizeIndianMobile('   ')).toBeNull();
  });
});

/**
 * Customer phone — the gentler rule for customer-facing fields (leads, parties,
 * check-ins, quotes): customers may be foreign (client, 13 Oct), so 8-15 digits
 * with an optional leading `+` pass; the strict rules above stay for staff.
 */
describe('normalizeCustomerPhone', () => {
  it('accepts a clean 10-digit Indian mobile unchanged', () => {
    expect(normalizeCustomerPhone('9876500000')).toBe('9876500000');
  });

  it('accepts an international number and keeps the leading +', () => {
    expect(normalizeCustomerPhone('+971 55 123 4567')).toBe('+971551234567');
    expect(normalizeCustomerPhone('+44 (20) 7946-0958')).toBe('+442079460958');
  });

  it('accepts a bare international number (optional +)', () => {
    expect(normalizeCustomerPhone('971551234567')).toBe('971551234567');
  });

  it('REJECTS letters and stray symbols, same as the strict rule', () => {
    expect(normalizeCustomerPhone('9876a500000')).toBeNull();
    expect(normalizeCustomerPhone('+971#551234567')).toBeNull();
    expect(normalizeCustomerPhone('call +971551234567')).toBeNull();
  });

  it('REJECTS fewer than 8 or more than 15 digits', () => {
    expect(normalizeCustomerPhone('+1234567')).toBeNull();
    expect(normalizeCustomerPhone('+1234567890123456')).toBeNull();
  });

  it('REJECTS a + anywhere but the front', () => {
    expect(normalizeCustomerPhone('44+2079460958')).toBeNull();
  });

  it('REJECTS empty', () => {
    expect(normalizeCustomerPhone('')).toBeNull();
    expect(normalizeCustomerPhone('   ')).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('accepts a normal address', () => {
    expect(isValidEmail('owner@eclatdiamonds.in')).toBe(true);
  });
  it('rejects malformed / spaced / no-domain', () => {
    expect(isValidEmail('owner@eclatdiamonds')).toBe(false);
    expect(isValidEmail('owner @x.com')).toBe(false);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
