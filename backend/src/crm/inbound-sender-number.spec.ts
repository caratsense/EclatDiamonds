import { IdentityService } from './identity.service';

/**
 * The incident, 22-23 November: a customer wrote in from +65 9383 5143. WhatsApp
 * delivered `from: "6593835143"`. Ten digits beginning with a 6 is also a valid
 * Indian mobile, so the tenant's country was applied and it was stored as
 * `916593835143` — a number belonging to nobody. Two replies went to it and came
 * back "This number cannot receive WhatsApp messages" (131026), on a thread the
 * customer had opened themselves.
 *
 * The rule: a number the PROVIDER hands us already carries its country. A number
 * a PERSON types does not. Only the caller knows which it is.
 */

describe('a number that arrives from the provider', () => {
  /*
   * `normalize` is pure — it touches no collaborator — so the three the
   * constructor asks for are stubs. Spelled out rather than spread, because
   * the first version of this file passed two and the production image build
   * failed on it three times: specs ARE compiled by `nest build` here (there
   * is one tsconfig and it excludes nothing), so a type error in a test file
   * stops a deploy while `npm run test:unit` stays green.
   */
  const stub = {} as never;
  const identity = new IdentityService(stub, stub, stub);
  const inbound = { alreadyInternational: true };

  it('keeps a foreign number exactly as the provider sent it', () => {
    expect(identity.normalize('whatsapp', '6593835143', 'IN', inbound)).toBe('6593835143');
  });

  it('does not touch an Indian number that already carries its code', () => {
    expect(identity.normalize('whatsapp', '917710097550', 'IN', inbound)).toBe('917710097550');
  });

  it('still rejects something too short to be a real number', () => {
    expect(identity.normalize('whatsapp', '12345', 'IN', inbound)).toBeNull();
  });

  it('leaves a typed local number alone — the tenant country still applies there', () => {
    // Every other caller passes no flag: somebody typing "9876543210" into a box
    // in an Indian tenant means +91, and must keep meaning that.
    expect(identity.normalize('whatsapp', '9876543210', 'IN')).toBe('919876543210');
  });

  it('is the ambiguity itself: the same ten digits mean different things', () => {
    /*
     * This pair is the whole reason the caller must declare the source rather
     * than the parser guessing. Identical input, two correct answers, decided
     * only by where the digits came from.
     */
    expect(identity.normalize('whatsapp', '6593835143', 'IN', inbound)).toBe('6593835143');
    expect(identity.normalize('whatsapp', '6593835143', 'IN')).toBe('916593835143');
  });

  it('a leading + is still honoured with or without the flag', () => {
    expect(identity.normalize('whatsapp', '+65 9383 5143', 'IN')).toBe('6593835143');
    expect(identity.normalize('whatsapp', '+65 9383 5143', 'IN', inbound)).toBe('6593835143');
  });
});
