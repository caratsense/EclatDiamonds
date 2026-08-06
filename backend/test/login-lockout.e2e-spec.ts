import { LoginLockout, LOGIN_MAX_FAILS } from '../src/auth/login-lockout';

/**
 * The account-lockout state machine behind /auth/login. Pure logic (the clock is
 * injected), so it runs without an app or DB — same style as the other specs in
 * this folder. Pins the security-relevant behaviour: freeze after N fails, stay
 * frozen for the window, and a clean login clears the counter.
 */
describe('LoginLockout', () => {
  it('freezes a handle only after MAX_FAILS consecutive failures', () => {
    const lock = new LoginLockout(LOGIN_MAX_FAILS, 15 * 60_000, () => 1_000);
    // The first MAX_FAILS-1 fails do not lock; the app still answers "Invalid".
    for (let i = 0; i < LOGIN_MAX_FAILS - 1; i++) {
      lock.fail('a@x');
      expect(lock.isLocked('a@x')).toBe(false);
    }
    lock.fail('a@x'); // the MAX_FAILS-th fail trips the freeze
    expect(lock.isLocked('a@x')).toBe(true);
  });

  it('lifts the freeze once the window passes', () => {
    let now = 1_000;
    const lock = new LoginLockout(3, 10_000, () => now);
    lock.fail('b@x');
    lock.fail('b@x');
    lock.fail('b@x');
    expect(lock.isLocked('b@x')).toBe(true);
    now += 10_001; // window elapsed
    expect(lock.isLocked('b@x')).toBe(false);
  });

  it('a clean login clears the counter, so the next fail starts from zero', () => {
    const lock = new LoginLockout(3, 10_000, () => 1_000);
    lock.fail('c@x');
    lock.fail('c@x');
    lock.clear('c@x'); // successful sign-in
    lock.fail('c@x'); // this is the 1st fail again, not the 3rd
    expect(lock.isLocked('c@x')).toBe(false);
  });

  it('locks each handle independently — one under attack does not freeze another', () => {
    const lock = new LoginLockout(2, 10_000, () => 1_000);
    lock.fail('victim@x');
    lock.fail('victim@x');
    expect(lock.isLocked('victim@x')).toBe(true);
    expect(lock.isLocked('bystander@x')).toBe(false);
  });
});
