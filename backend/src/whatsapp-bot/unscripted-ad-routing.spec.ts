import { answeredByBranchNotBot } from './campaign-bot.service';

/**
 * An advert nobody scripted must not be answered by the bot.
 *
 * On 27 Nov a customer tapped a blue-diamond advert, asked "Can I get more info
 * on this?", and was put through four questions from a questionnaire that
 * predates the campaign editor: a wave, what are you looking for, what is your
 * budget, when are you buying. The tenant has three ad scripts, all bridal, and
 * that advert matches none of them — so the thread fell past the campaign
 * script, past the tenant's own walk-in conversation, and into the fallback.
 *
 * The client's rule: an advert with no script goes to the shop it was bought
 * for, to a person. Organic first contacts keep the questionnaire, because no
 * branch is implied by a QR code and silence is the only alternative.
 */
describe('who answers an enquiry the bot has no script for', () => {
  it('sends an unscripted ADVERT to the branch, not the questionnaire', () => {
    expect(answeredByBranchNotBot({ scripted: false, adId: '120256795604450226' })).toBe(true);
  });

  it('leaves a scripted advert to its own script', () => {
    // The bridal campaigns still answer their own enquiries, word for word.
    expect(answeredByBranchNotBot({ scripted: true, adId: '120256795604450226' })).toBe(false);
  });

  it('leaves ORGANIC first contacts with the bot', () => {
    // A QR code, Google, the website: no advert, no branch implied, and nobody
    // waiting for them. Taking the bot away here would replace a reply with
    // silence.
    expect(answeredByBranchNotBot({ scripted: false, adId: null })).toBe(false);
    expect(answeredByBranchNotBot({ scripted: false })).toBe(false);
  });

  it('does not treat an empty ad id as an advert', () => {
    // A referral that arrived with the field present but blank is not evidence
    // of an advert, and routing on it would strand the thread at no branch.
    expect(answeredByBranchNotBot({ scripted: false, adId: '' })).toBe(false);
  });
});
