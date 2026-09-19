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

describe('HrmsService.evaluateFence', () => {
  it('allows an in-fence check-in and reports it verified', () => {
    const r = evaluateFence(store(), MUMBAI.latitude, MUMBAI.longitude, undefined, 'check-in');
    expect(r.withinFence).toBe(true);
    expect(r.distanceM).toBe(0);
  });

  it('BLOCKS an out-of-fence check-in even with a reason', () => {
    // ~1 km north of the centre, well outside the 150 m radius.
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    expect(() =>
      evaluateFence(store(), far.lat, far.lng, 'customer visit', 'check-in'),
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

  it('far outside even allowing for the error is still blocked', () => {
    const far = { lat: MUMBAI.latitude + 0.01, lng: MUMBAI.longitude };
    expect(() => evaluateFence(store(), far.lat, far.lng, 'reason', 'check-in', 50)).toThrow(/must be at the store/);
  });
});
