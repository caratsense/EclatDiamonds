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

  it('SAFETY: a store with no coordinates never blocks a punch', () => {
    const noFence = store({ latitude: null, longitude: null });
    const r = evaluateFence(noFence, undefined, undefined, undefined, 'check-in');
    expect(r.withinFence).toBe(true);
    expect(r.distanceM).toBeNull();
  });
});
