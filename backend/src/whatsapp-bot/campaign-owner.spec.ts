import { campaignTurnNeedsAnOwner } from './campaign-bot.service';

/**
 * An ad thread that reaches the branch and never reaches a person.
 *
 * Client, 28 Nov: "it lists the store as Mumbai Bandra correctly, but it is
 * still not routing to the particular store manager." Both halves were true.
 * The three live bridal rules name a store and the thread adopts it, so the
 * inbox shows the right shop — and all three carry `assignedUserId: null`, so
 * the only thing that could put a person on the thread was the handoff at the
 * END of the script. A customer who taps the advert, reads the campaign's
 * reply and never writes again never reaches that end, so the lead sat at the
 * right branch owned by nobody while the ads kept being paid for.
 *
 * These assertions are about WHEN the branch takes it, which is the part that
 * is easy to get wrong in either direction: wait for the script to finish and
 * an abandoned lead reaches nobody, ring on every bot turn and the bell that
 * mattered is lost in the ones that did not.
 */
describe('when a campaign turn has to put a person on the thread', () => {
  const turn = {
    spoke: true,
    handedOff: false,
    owned: false,
    namesSomewhere: true,
  };

  it('gives the branch the lead as soon as the campaign has spoken', () => {
    // The Mumbai Bandra bridal ad exactly: the script has said its piece and
    // the customer may never type another word.
    expect(campaignTurnNeedsAnOwner(turn)).toBe(true);
  });

  it('rings once, not on every bot turn', () => {
    // The second and every later turn of the same script sees the owner the
    // first one named. A bell per turn is noise, and noise is how the one that
    // mattered gets ignored.
    expect(campaignTurnNeedsAnOwner({ ...turn, owned: true })).toBe(false);
  });

  it('leaves a turn that already hands off alone', () => {
    // That path hands the thread over itself, with the script's own reason and
    // its summary. Doing both would ring one branch twice for one lead.
    expect(campaignTurnNeedsAnOwner({ ...turn, handedOff: true })).toBe(false);
  });

  it('does nothing on a turn that said nothing to the customer', () => {
    expect(campaignTurnNeedsAnOwner({ ...turn, spoke: false })).toBe(false);
  });

  it('leaves the walk-in conversation unowned', () => {
    // An ORGANIC first contact — a QR code, Google, the website — is answered
    // by the tenant's walk-in script, which names no branch and no person. The
    // honest answer is nobody, exactly as it is for an advert that matched no
    // rule: inventing a branch sends a customer to people who never ran an ad
    // for them.
    expect(campaignTurnNeedsAnOwner({ ...turn, namesSomewhere: false })).toBe(false);
  });
});
