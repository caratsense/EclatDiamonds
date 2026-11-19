import { chooseHandoffOwner, chooseHandoffStore, handoffAudience } from './handoff-destination';

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
 * Then the Mumbai Bandra bridal ad found the third: that branch had no manager
 * who could open Conversations, only salespeople, so its enquiries reached
 * nobody at all. The client's answer widened both ends — anybody assigned to
 * that store may own it, and the whole store is told.
 *
 * These assertions are about the order of preference, which is the part that
 * is easy to get subtly wrong: a person who already took the thread outranks
 * everyone, then the script's own named owner, then the branch's manager, and
 * only then a salesperson there.
 */

const chooseOwner = chooseHandoffOwner;
const chooseStore = (i: { onThread: string | null; fromRule: string | null }) =>
  chooseHandoffStore(i.onThread, i.fromRule);

describe('who takes the conversation', () => {
  it('leaves it with whoever already picked it up', () => {
    // A manager who took this by hand outranks every automatic choice; the
    // alternative is the bot reassigning a thread out from under someone
    // mid-reply.
    expect(
      chooseOwner({ holder: 'u-asha', named: 'u-karan', manager: 'u-mgr', salesperson: 'u-rep' }),
    ).toBe('u-asha');
  });

  it('gives it to the person the script names, over the branch manager', () => {
    // "or store people or whosoever they want to assign" — a script that
    // nominates somebody is more specific than "the first manager there".
    expect(
      chooseOwner({ holder: null, named: 'u-karan', manager: 'u-mgr', salesperson: 'u-rep' }),
    ).toBe('u-karan');
  });

  it('falls back to the branch manager', () => {
    expect(chooseOwner({ holder: null, named: null, manager: 'u-mgr', salesperson: 'u-rep' })).toBe(
      'u-mgr',
    );
  });

  it('falls back to a salesperson there when no manager can open Conversations', () => {
    // Mumbai Bandra exactly: the ad ran, the script finished, and the branch
    // had nobody with the manager role to hand it to. A salesperson at that
    // counter is a far better answer than nobody.
    expect(chooseOwner({ holder: null, named: null, manager: null, salesperson: 'u-rep' })).toBe(
      'u-rep',
    );
  });

  it('is nobody when the ad matched no script with a branch', () => {
    // Deliberately not "the nearest showroom". An invented branch sends a
    // customer's enquiry to people who never ran that ad.
    expect(chooseOwner({ holder: null, named: null, manager: null, salesperson: null })).toBeNull();
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

describe('who is told about it', () => {
  it('tells the whole branch, owner first', () => {
    // The client, after the Bandra ad reached nobody: the conversation goes to
    // everybody assigned to that store. The owner leads because the bell is
    // written to say who has it.
    expect(handoffAudience('u-mgr', ['u-rep-1', 'u-mgr', 'u-rep-2'])).toEqual([
      'u-mgr',
      'u-rep-1',
      'u-rep-2',
    ]);
  });

  it('tells an owner who does not work at that branch', () => {
    // Whoever already held the thread keeps it even if head office gave it to
    // them, and they are the one person who must not be dropped.
    expect(handoffAudience('u-ho', ['u-rep-1'])).toEqual(['u-ho', 'u-rep-1']);
  });

  it('still tells the branch when nobody could be named as owner', () => {
    expect(handoffAudience(null, ['u-rep-1'])).toEqual(['u-rep-1']);
  });

  it('tells nobody when there is no branch and no owner', () => {
    // The ad matched no script with a branch: there is no right recipient, and
    // every manager in the business is not it.
    expect(handoffAudience(null, [])).toEqual([]);
  });
});
