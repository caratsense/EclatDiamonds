import { normalizeIndianMobile, isValidEmail } from '../src/common/contact.util';

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
