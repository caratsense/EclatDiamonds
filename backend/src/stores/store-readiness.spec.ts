import {
  StoreLifecycleFacts,
  refuseActivation,
  storeSetupGaps,
} from './store-readiness';

/**
 * What stops a branch opening, and what merely goes unfinished on it.
 *
 * The report behind these: the client could not activate INDORE RATNAMANI
 * COMPLEX. The screen said "Geofence missing", "Region missing", and a toast
 * said "Could not activate this branch — it may still be missing details." Her
 * answer is the rule now encoded here: "Geofencing could be set up later on
 * when we want it. The store should at least be activated without that
 * geofence so that we can start operating on it."
 *
 * So the two halves are tested apart, because that is the mistake: activation
 * must not care about a geofence or a region, and the branch must still say it
 * has neither.
 */
const branch = (over: Partial<StoreLifecycleFacts> = {}): StoreLifecycleFacts => ({
  isAggregate: false,
  isHolding: false,
  isActive: false,
  status: 'pending',
  attendanceOnly: false,
  latitude: '22.7196000',
  longitude: '75.8577000',
  regionId: 'region_west',
  ...over,
});

describe('a branch can go live without the things it is not yet complete without', () => {
  it('activates with no geofence and no region', () => {
    expect(
      refuseActivation(branch({ latitude: null, longitude: null, regionId: null })),
    ).toBeNull();
  });

  it('activates with a region but no geofence — the Indore case', () => {
    expect(refuseActivation(branch({ latitude: null, longitude: null }))).toBeNull();
  });

  it('activates with a geofence but no region', () => {
    expect(refuseActivation(branch({ regionId: null }))).toBeNull();
  });

  it('activates an attendance-only office, which is in no sales region by design', () => {
    expect(
      refuseActivation(branch({ attendanceOnly: true, regionId: null })),
    ).toBeNull();
  });

  it('reopens a closed branch whose coordinates were cleared while it was shut', () => {
    expect(
      refuseActivation(
        branch({ status: 'closed', latitude: null, longitude: null }),
      ),
    ).toBeNull();
  });

  it('half a coordinate pair is still no geofence, and still does not refuse', () => {
    expect(refuseActivation(branch({ longitude: null }))).toBeNull();
  });
});

describe('what is still refused', () => {
  it('refuses the synthetic "All Stores" aggregate, which is a view', () => {
    expect(refuseActivation(branch({ isAggregate: true }))).toBe('aggregate');
  });

  it('refuses the unassigned import bucket, which is not a place anyone works', () => {
    expect(refuseActivation(branch({ isHolding: true }))).toBe('holding');
  });

  it('refuses a branch that is already active', () => {
    expect(refuseActivation(branch({ status: 'active', isActive: true }))).toBe(
      'already_active',
    );
  });

  it('refuses one whose two lifecycle columns disagree, from either side', () => {
    // status and isActive are one invariant that an older generic edit could
    // leave half-written. Either column saying "open" makes a second
    // activation a conflict, not an event.
    expect(refuseActivation(branch({ status: 'active', isActive: false }))).toBe(
      'already_active',
    );
    expect(refuseActivation(branch({ status: 'pending', isActive: true }))).toBe(
      'already_active',
    );
  });

  it('puts the aggregate and holding checks ahead of the lifecycle one', () => {
    // Both rows are seeded active, so answering "already active" about them
    // would tell head office to try again rather than that it picked a row
    // that is not a branch.
    expect(
      refuseActivation(branch({ isAggregate: true, status: 'active', isActive: true })),
    ).toBe('aggregate');
    expect(
      refuseActivation(branch({ isHolding: true, status: 'active', isActive: true })),
    ).toBe('holding');
  });
});

describe('the gaps are still reported, on a live branch as much as a pending one', () => {
  it('names a missing geofence', () => {
    expect(storeSetupGaps(branch({ latitude: null, longitude: null }))).toEqual({
      needsGeo: true,
      needsRegion: false,
    });
  });

  it('counts a half-written pair as missing — one coordinate locates nothing', () => {
    expect(storeSetupGaps(branch({ latitude: null }))).toMatchObject({ needsGeo: true });
    expect(storeSetupGaps(branch({ longitude: null }))).toMatchObject({ needsGeo: true });
  });

  it('names a missing region', () => {
    expect(storeSetupGaps(branch({ regionId: null }))).toEqual({
      needsGeo: false,
      needsRegion: true,
    });
  });

  it('reads an empty-string region as no region, not as a region named ""', () => {
    expect(storeSetupGaps(branch({ regionId: '' }))).toMatchObject({ needsRegion: true });
  });

  it('does not call a missing region a gap for an attendance-only office', () => {
    expect(storeSetupGaps(branch({ attendanceOnly: true, regionId: null }))).toEqual({
      needsGeo: false,
      needsRegion: false,
    });
  });

  it('still wants a geofence at an attendance-only office, which is all it is for', () => {
    expect(
      storeSetupGaps(branch({ attendanceOnly: true, regionId: null, latitude: null })),
    ).toEqual({ needsGeo: true, needsRegion: false });
  });

  it('reports nothing on a fully set-up branch', () => {
    expect(storeSetupGaps(branch())).toEqual({ needsGeo: false, needsRegion: false });
  });

  it('reads a Prisma Decimal of zero as a coordinate, not as absent', () => {
    // Null Island is a real place and 0 is a falsy number; a branch sitting on
    // the equator or the prime meridian must not read as unfenced.
    expect(
      storeSetupGaps(branch({ latitude: { toString: () => '0' }, longitude: 0 })),
    ).toMatchObject({ needsGeo: false });
  });
});
