/**
 * Per-handle login lockout for /auth/login.
 *
 * In-memory + single-instance (ponytail: Railway runs one web dyno; state resets
 * on restart). It pairs with the tighter per-IP @Throttle on the login route:
 * the throttle caps how fast anyone can try, this freezes a single handle after
 * repeated failures so a slow, IP-rotating guess against one account still hits
 * a wall. Move to a DB column / Redis if the app ever scales horizontally or the
 * freeze must survive a restart.
 *
 * The clock is injectable so the state machine is unit-testable without waiting
 * real minutes.
 */
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

export class LoginLockout {
  private readonly fails = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly maxFails = LOGIN_MAX_FAILS,
    private readonly lockMs = LOGIN_LOCK_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True while the handle is frozen — check this before the password compare. */
  isLocked(key: string): boolean {
    const rec = this.fails.get(key);
    return !!rec && rec.lockedUntil > this.now();
  }

  /** Record a failed attempt; freeze the handle once it crosses the threshold. */
  fail(key: string): void {
    // Blunt memory bound so a flood of distinct handles can't grow the map
    // without limit (the per-IP throttle already caps the inflow rate).
    if (this.fails.size > 10_000) this.fails.clear();
    const rec = this.fails.get(key) ?? { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= this.maxFails) {
      rec.lockedUntil = this.now() + this.lockMs;
      rec.count = 0; // the lock gates now; the counter restarts once it lifts
    }
    this.fails.set(key, rec);
  }

  /** A clean login clears the counter for this handle. */
  clear(key: string): void {
    this.fails.delete(key);
  }
}
