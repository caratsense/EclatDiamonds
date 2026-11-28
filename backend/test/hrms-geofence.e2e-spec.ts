import { BadRequestException } from '@nestjs/common';
import { HrmsService } from '../src/hrms/hrms.service';

/**
 * Geofence gate for attendance punches (Module 6). Pure decision logic, so it's
 * exercised directly against the private `evaluateFence` with stub deps.
 *
 * Pins the two things the bug report got wrong:
 *  - an out-of-fence CHECK-IN is BLOCKED (never recorded as on-time), while a
 *    check-out stays lenient (recorded with a reason);
 *  - SAFETY: a store with NO coordinates configured never blocks anyone.
 */
const MUMBAI = { latitude: 19.229, longitude: 72.857 };
const store = (over: Partial<any> = {}) => ({
  id: 's1',
  name: 'Borivali',
  tz: 'Asia/Kolkata',
  latitude: MUMBAI.latitude,
  longitude: MUMBAI.longitude,
  geofenceRadiusM: 150,
  weekOffDay: null,
  ...over,
});

// evaluateFence uses none of the constructor deps. Spread rather than a fixed
// list of nulls, so adding a dependency to the service does not break a test
// that never touches one.
const svc = new (HrmsService as unknown as new (...args: unknown[]) => HrmsService)(
  ...(Array(8).fill(null) as unknown[]),
);
const evaluateFence = (...args: any[]) =>
  (svc as any).evaluateFence(...args);
const unverifiedReason = (...args: any[]) =>
  (svc as any).unverifiedReason(...args);

describe('HrmsService.evaluateFence', () => {
  it('allows an in-fence check-in and reports it verified', () => {
    const r = evaluateFence(store(), MUMBAI.latitude, MUMBAI.longitude, undefined, 'check-in');
    expect(r.withinFence).toBe(true);
    expect(r.distanceM).toBe(0);
  });

  it('records an out-of-fence check-in WITH a reason, flagged for review', () => {
    /*
     * This asserted the opposite until the showroom proved it wrong. A phone
     * indoors at Roha Orion reports 50-150 m of drift against a coordinate
     * that is a street centroid, so staff standing at the counter were told
     * they were 635 m away and could not start their shift. The fence now
     * decides whether a punch is VERIFIED, not whether it is permitted.
     */
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    const r = evaluateFence(store(), far.lat, far.lng, 'customer visit', 'check-in');
    expect(r.withinFence).toBe(false);
    expect(r.distanceM).toBeGreaterThan(150);
  });

  it('still REFUSES an out-of-fence check-in with no reason', () => {
    // The part that must not relax: an unexplained out-of-fence punch is
    // indistinguishable from a buddy punch, so the reason is what buys it in.
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    expect(() =>
      evaluateFence(store(), far.lat, far.lng, undefined, 'check-in'),
    ).toThrow(BadRequestException);
  });

  it('allows an out-of-fence check-OUT when a reason is supplied (flagged, not blocked)', () => {
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    const r = evaluateFence(store(), far.lat, far.lng, 'left for delivery', 'check-out');
    expect(r.withinFence).toBe(false);
    expect(r.distanceM).toBeGreaterThan(150);
  });

  it('SAFETY: a store with no coordinates allows but never verifies a punch', () => {
    const noFence = store({ latitude: null, longitude: null });
    const r = evaluateFence(noFence, undefined, undefined, undefined, 'check-in');
    expect(r.withinFence).toBe(false);
    expect(r.distanceM).toBeNull();
  });

  it('SAFETY: it does not demand a reason for a gap in head office\'s own setup', () => {
    // A perfectly good fix at a branch with no fence. Since activation stopped
    // requiring coordinates (28 Nov) a branch can trade for months like this,
    // and asking every staffer there to justify every punch would be charging
    // them for a geofence nobody has typed in.
    const noFence = store({ latitude: null, longitude: null });
    const r = evaluateFence(noFence, MUMBAI.latitude, MUMBAI.longitude, undefined, 'check-in', 10);
    expect(r).toEqual({ distanceM: null, withinFence: false });
  });
});

/**
 * The sentence an unverified punch carries.
 *
 * Three different things leave a punch unverified, and they used to share two
 * sentences between them — so each could print the other's. A branch with no
 * coordinates was reported as "no location fix", which blames a phone that
 * worked; and a device with no fix at a fenced branch was reported as "no
 * geofence set", which blames a branch that is set up. Both reach a manager
 * who has to decide what to do about it.
 */
describe('HrmsService.unverifiedReason', () => {
  it('names the branch, not the phone, when the branch has no geofence', () => {
    const noFence = store({ latitude: null, longitude: null });
    expect(unverifiedReason(noFence, null)).toBe(
      'Borivali has no geofence set, so this punch could not be location-checked',
    );
  });

  it('says so even when half the coordinate pair is present', () => {
    expect(unverifiedReason(store({ longitude: null }), null)).toMatch(/has no geofence set/);
  });

  it('names the phone when the branch IS fenced and no fix arrived', () => {
    expect(unverifiedReason(store(), null)).toBe('no location fix at Borivali');
  });

  it('gives the distance and the allowance when there was a fix to measure', () => {
    expect(unverifiedReason(store(), 635)).toBe('635 m from Borivali (allowed: 150 m)');
  });
});

/**
 * How sure the fix is. A reported accuracy that reaches across the fence cannot
 * confirm or refute presence, so the punch needs a reason instead of a guess.
 */
describe('HrmsService.evaluateFence — GPS accuracy', () => {
  // ~100 m north of the centre, inside a 150 m fence.
  const near = { lat: MUMBAI.latitude + 0.0009, lng: MUMBAI.longitude };
  // ~200 m north: outside the fence, but within reach of a 120 m error.
  const edge = { lat: MUMBAI.latitude + 0.0018, lng: MUMBAI.longitude };

  it('a precise fix inside the fence is verified as before', () => {
    const r = evaluateFence(store(), near.lat, near.lng, undefined, 'check-in', 10);
    expect(r.withinFence).toBe(true);
  });

  it('a fix too imprecise to confirm the fence needs a reason, and says why', () => {
    expect(() => evaluateFence(store(), near.lat, near.lng, undefined, 'check-in', 400)).toThrow(
      /only accurate to about 400 m/,
    );
    const r = evaluateFence(store(), near.lat, near.lng, 'indoors, weak GPS', 'check-in', 400);
    expect(r.withinFence).toBe(false);
  });

  it('just outside, but within the error, is a reason — not an outright block', () => {
    expect(() => evaluateFence(store(), edge.lat, edge.lng, undefined, 'check-in', 120)).toThrow(
      /only accurate/,
    );
    expect(evaluateFence(store(), edge.lat, edge.lng, 'at the side entrance', 'check-in', 120).withinFence).toBe(false);
  });

  it('far outside even allowing for the error is recorded, not blocked', () => {
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    const r = evaluateFence(store(), far.lat, far.lng, 'reason', 'check-in', 50);
    expect(r.withinFence).toBe(false);
    expect(r.distanceM).toBeGreaterThan(150);
  });

  it('far outside with NO reason is still refused', () => {
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    expect(() => evaluateFence(store(), far.lat, far.lng, undefined, 'check-in', 50))
      .toThrow(/Add a reason/);
  });
});
