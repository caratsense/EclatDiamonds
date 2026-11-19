import { chooseHandoffOwner, chooseHandoffStore } from './handoff-destination';

/**
 * Where a conversation goes when the script runs out.
 *
 * The client watched a thread finish its script and sit at "No store yet ·
 * Unassigned", with the reassign dialog offering "No location (central
 * queue)" and "Nobody". Her instruction: after the last message of the script
 * it should go to the branch the ad ran for, or to whoever that script names.
 *
 * Two things were missing. The thread only ever took its branch at the FIRST
 * message, so a script given its branch afterwards never passed it on; and the
 * handoff looked for a manager only when the thread already had a branch, so a
 * thread without one was handed to nobody and nothing said why.
 *
 * These assertions are about the order of preference, which is the part that
 * is easy to get subtly wrong: a person who already took the thread outranks
 * everyone, then the script's own named owner, then the branch's manager.
 */

const chooseOwner = chooseHandoffOwner;
const chooseStore = (i: { onThread: string | null; fromRule: string | null }) =>
  chooseHandoffStore(i.onThread, i.fromRule);

describe('who takes the conversation', () => {
  it('leaves it with whoever already picked it up', () => {
    // A manager who took this by hand outranks every automatic choice; the
    // alternative is the bot reassigning a thread out from under someone
    // mid-reply.
    expect(chooseOwner({ holder: 'u-asha', named: 'u-karan', manager: 'u-mgr' })).toBe('u-asha');
  });

  it('gives it to the person the script names, over the branch manager', () => {
    // "or store people or whosoever they want to assign" — a script that
    // nominates somebody is more specific than "the first manager there".
    expect(chooseOwner({ holder: null, named: 'u-karan', manager: 'u-mgr' })).toBe('u-karan');
  });

  it('falls back to the branch manager', () => {
    expect(chooseOwner({ holder: null, named: null, manager: 'u-mgr' })).toBe('u-mgr');
  });

  it('is nobody when the ad matched no script with a branch', () => {
    // Deliberately not "the nearest showroom". An invented branch sends a
    // customer's enquiry to people who never ran that ad.
    expect(chooseOwner({ holder: null, named: null, manager: null })).toBeNull();
  });
});

describe('which branch the thread lands at', () => {
  it('keeps the branch it already has', () => {
    expect(chooseStore({ onThread: 'mumbai-bandra', fromRule: 'delhi-rohini' })).toBe(
      'mumbai-bandra',
    );
  });

  it('adopts the branch the script names when it has none', () => {
    // The case the client saw: the rule was given its branch after the thread
    // had already started, so the thread never picked it up.
    expect(chooseStore({ onThread: null, fromRule: 'mumbai-bandra-broadway' })).toBe(
      'mumbai-bandra-broadway',
    );
  });

  it('stays branchless when the script names none', () => {
    expect(chooseStore({ onThread: null, fromRule: null })).toBeNull();
  });
});
