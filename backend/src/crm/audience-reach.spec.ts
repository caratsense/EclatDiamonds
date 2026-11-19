import { audienceRefusal } from './campaigns.service';

/**
 * The server's last word on who a broadcast reaches.
 *
 * The wizard disables its own send button on an uncounted or empty audience,
 * but the wizard is a browser: submit and approve are ordinary endpoints and
 * can be POSTed at directly. This is the decision both of them come through,
 * and it is the reason a campaign cannot be released to nobody.
 */
describe('refusing an audience that reaches nobody', () => {
  it('refuses rules that match no one, and says to change them', () => {
    const refusal = audienceRefusal({ total: 0, contactable: 0 });
    expect(refusal).toContain('match nobody');
    expect(refusal).toContain('Change the audience');
  });

  it('refuses an audience where nobody has a number, and names how many matched', () => {
    // A different mistake with a different fix: the rules are right, the
    // records are missing numbers. Saying "40" is what makes that visible.
    const refusal = audienceRefusal({ total: 40, contactable: 0 });
    expect(refusal).toContain('None of the 40 people who match');
    expect(refusal).toContain('phone or WhatsApp number');
  });

  it('allows an audience with one reachable person', () => {
    expect(audienceRefusal({ total: 1, contactable: 1 })).toBeNull();
  });

  it('allows an audience where only some are reachable', () => {
    // The unreachable ones are excluded at expansion and reported; they are
    // not a reason to refuse the whole broadcast.
    expect(audienceRefusal({ total: 1200, contactable: 3 })).toBeNull();
  });
});
