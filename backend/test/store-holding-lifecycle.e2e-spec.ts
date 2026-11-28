import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Store lifecycle regressions around the sync-only "Unassigned" holding store.
 *
 * A holding store is a quarantine bucket for imported rows that name no branch.
 * It is not a branch a customer may select, a branch head office may activate or
 * staff, or a branch that belongs in setup-readiness counts. These tests use the
 * real HTTP doors and database because a DTO-only/unit assertion would miss the
 * exact leaks this boundary is meant to close.
 */
const PASSWORD = 'password123';
const PROFILE_ID = 'store-holding-e2e';
const PROFILE_HASH = 'c'.repeat(64);
const SOURCE_INSTANCE_HASH = 'd'.repeat(64);

const A = {
  org: 'org_store_holding_e2e',
  slug: 'store-holding-e2e',
  ho: 'ho.store-holding-e2e@test.local',
  areaManager: 'area.store-holding-e2e@test.local',
  active: 'store-holding-active',
  active2: 'store-holding-active-2',
  office: 'store-holding-office',
  pending: 'store-holding-pending',
  pendingRace: 'store-holding-pending-race',
  unfenced: 'store-holding-unfenced',
  unfencedOffice: 'store-holding-unfenced-office',
  activateRace: 'store-holding-activate-race',
  newLegacy: 'STORE-HOLDING-NEW',
  orphanParty: 'STORE-HOLDING-PARTY',
  rejectedManager: 'manager.store-holding-e2e@test.local',
  region: 'region_store_holding_e2e',
  otherRegion: 'region_store_holding_e2e_other',
};

const B = {
  org: 'org_store_holding_foreign',
  slug: 'store-holding-foreign',
  region: 'region_store_holding_foreign',
  sharedCodeStore: 'shared-branch-code',
};

describe('Store holding/location lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoToken: string;
  let areaManagerToken: string;
  let agentToken: string;
  let agentId: string;
  let configRevision: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const asAgent = () => ({
    Authorization: `Bearer ${agentToken}`,
    'x-caratos-profile-id': PROFILE_ID,
    'x-caratos-profile-hash': PROFILE_HASH,
    'x-caratos-source-instance-hash': SOURCE_INSTANCE_HASH,
    'x-caratos-config-revision': configRevision,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await teardown(prisma);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Store Holding E2E', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.organisation.create({
      data: { id: B.org, name: 'Store Holding Foreign', slug: B.slug, industryPackCode: 'jewellery' },
    });
    await prisma.region.create({
      data: { id: A.region, organisationId: A.org, name: 'West', code: 'SHE-WEST' },
    });
    await prisma.region.create({
      data: {
        id: A.otherRegion,
        organisationId: A.org,
        name: 'North',
        code: 'SHE-NORTH',
      },
    });
    await prisma.region.create({
      data: { id: B.region, organisationId: B.org, name: 'Foreign', code: 'SHE-FOREIGN' },
    });
    await prisma.store.create({
      data: {
        id: B.sharedCodeStore,
        organisationId: B.org,
        name: 'Foreign Shared Code',
        city: 'Delhi',
        code: 'shared-branch-code',
        regionId: B.region,
        latitude: '28.6000000',
        longitude: '77.2000000',
        status: 'active',
        isActive: true,
      },
    });

    // Two linked branches make unattributedMode=holding create the quarantine
    // location. Both have complete profiles so they do not pollute missingGeo.
    await prisma.store.create({
      data: {
        id: A.active,
        organisationId: A.org,
        legacyId: 'STORE-HOLDING-ACTIVE',
        name: 'Reviewed Active Branch',
        city: 'Reviewed City',
        code: 'REVIEWED-ACTIVE',
        addressLine1: 'Reviewed address',
        regionId: A.region,
        latitude: '19.0651400',
        longitude: '72.8307538',
        status: 'active',
        isActive: true,
      },
    });
    await prisma.store.create({
      data: {
        id: A.active2,
        organisationId: A.org,
        legacyId: 'STORE-HOLDING-ACTIVE-2',
        name: 'Second Active Branch',
        city: 'Second City',
        regionId: A.otherRegion,
        latitude: '18.9284830',
        longitude: '72.8326694',
        status: 'active',
        isActive: true,
      },
    });
    await prisma.store.create({
      data: {
        id: A.office,
        organisationId: A.org,
        name: 'Head Office',
        city: 'Mumbai',
        attendanceOnly: true,
        latitude: '19.1713342',
        longitude: '72.8572712',
        status: 'active',
        isActive: true,
      },
    });
    await prisma.store.create({
      data: {
        id: A.pending,
        organisationId: A.org,
        legacyId: 'STORE-HOLDING-PENDING',
        name: 'Old Pending Branch',
        city: 'Old Pending City',
        code: 'OLD-PENDING',
        addressLine1: 'Old pending address',
        status: 'pending',
        isActive: false,
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({
      data: {
        email: A.ho,
        name: 'Store Holding HO',
        role: 'head_office',
        passwordHash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: A.org,
      },
    });
    const areaManager = await prisma.user.create({
      data: {
        email: A.areaManager,
        name: 'Store Holding Area Manager',
        role: 'area_manager',
        passwordHash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: A.org,
      },
    });
    await prisma.userStore.create({
      data: { userId: areaManager.id, storeId: A.active, isPrimary: true },
    });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: A.ho, password: PASSWORD });
    expect(login.status).toBe(201);
    hoToken = login.body.token;

    const areaLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: A.areaManager, password: PASSWORD });
    expect(areaLogin.status).toBe(201);
    areaManagerToken = areaLogin.body.token;

    const enrolled = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(auth(hoToken))
      .send({ name: 'Store holding Gati agent', sourceSystem: 'gati' });
    expect(enrolled.status).toBe(201);
    agentToken = enrolled.body.token;
    agentId = enrolled.body.agent.id;

    const configured = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${agentId}/config`)
      .set(auth(hoToken))
      .send({
        config: {
          enabled: true,
          expectedProfileHash: PROFILE_HASH,
          expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
          unattributedMode: 'holding',
        },
      });
    expect(configured.status).toBe(201);
    configRevision = configured.body.config.configRevision;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('sync creates a tenant-owned holding store for an unattributed row', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({
        records: [
          {
            PartyNo: A.orphanParty,
            FirmName: 'Unattributed customer',
            IsCustomer: 1,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ received: 1, upserted: 1, skipped: 0 });

    const holding = await prisma.store.findUnique({
      where: { id: `unassigned:${A.org}` },
    });
    expect(holding).toMatchObject({
      id: `unassigned:${A.org}`,
      name: 'Unassigned — needs a branch',
      organisationId: A.org,
      status: 'pending',
      isActive: false,
      isHolding: true,
    });
    expect(
      await prisma.party.findUnique({
        where: { organisationId_legacyId: { organisationId: A.org, legacyId: A.orphanParty } },
        select: { storeId: true },
      }),
    ).toEqual({ storeId: holding!.id });
  });

  it('public directory lists physical branches, including one still under review, never holding rows', async () => {
    const res = await request(app.getHttpServer()).get(`/stores/directory?org=${A.slug}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string }>;
    // A pending branch is a shop whose staff need to sign up against it; the
    // import bucket is not a place anyone works.
    expect(rows.map((s) => s.id).sort()).toEqual([A.active, A.active2, A.pending].sort());
    expect(JSON.stringify(res.body)).not.toContain('unassigned:');
  });

  it('pending review lists real branches but excludes the holding store', async () => {
    const res = await request(app.getHttpServer())
      .get('/stores/pending')
      .set(auth(hoToken));
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; isHolding?: boolean }>;
    expect(rows.map((s) => s.id)).toContain(A.pending);
    expect(rows.map((s) => s.id)).not.toContain(`unassigned:${A.org}`);
    expect(rows.every((s) => s.isHolding !== true)).toBe(true);
  });

  it('a holding store cannot be activated even if geo and region are present', async () => {
    const holdingId = `unassigned:${A.org}`;
    await prisma.store.update({
      where: { id: holdingId },
      data: {
        regionId: A.region,
        latitude: '19.0000000',
        longitude: '72.0000000',
      },
    });

    const res = await request(app.getHttpServer())
      .patch(`/stores/${encodeURIComponent(holdingId)}/activate`)
      .set(auth(hoToken));
    expect([400, 409]).toContain(res.status);
    expect(String(res.body.message)).toMatch(/holding|unassigned/i);

    const unchanged = await prisma.store.findUniqueOrThrow({ where: { id: holdingId } });
    expect(unchanged).toMatchObject({ status: 'pending', isActive: false });
  });

  it('a holding store cannot be assigned a manager', async () => {
    const holdingId = `unassigned:${A.org}`;
    const res = await request(app.getHttpServer())
      .post(`/stores/${encodeURIComponent(holdingId)}/manager`)
      .set(auth(hoToken))
      .send({ name: 'Rejected Manager', email: A.rejectedManager, password: PASSWORD });

    expect([400, 409]).toContain(res.status);
    expect(String(res.body.message)).toMatch(/holding|unassigned/i);
    expect(await prisma.user.findUnique({ where: { email: A.rejectedManager } })).toBeNull();
    expect(await prisma.userStore.count({ where: { storeId: holdingId } })).toBe(0);
  });

  it('a sales-side write cannot use the holding bucket as a branch', async () => {
    const holdingId = `unassigned:${A.org}`;
    const before = await prisma.checkIn.count({ where: { storeId: holdingId } });

    const res = await request(app.getHttpServer())
      .post('/checkins')
      .set(auth(hoToken))
      .send({ storeId: holdingId, customerName: 'Must Not Be Recorded' });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/holding|physical store/i);
    expect(await prisma.checkIn.count({ where: { storeId: holdingId } })).toBe(before);
  });

  it('PATCH ignores isActive instead of exposing a second lifecycle door', async () => {
    // A browser still holding the previous bundle sends isActive on every save.
    // The save must succeed and the lifecycle must not move: only Activate and
    // Close change it, and both enforce readiness and write an audit entry.
    for (const isActive of [true, false]) {
      const res = await request(app.getHttpServer())
        .patch(`/stores/${A.pending}`)
        .set(auth(hoToken))
        .send({ isActive, city: 'Pune' });
      expect(res.status).toBe(200);
    }
    const unchanged = await prisma.store.findUniqueOrThrow({ where: { id: A.pending } });
    expect(unchanged).toMatchObject({ status: 'pending', isActive: false, city: 'Pune' });
  });

  it('an active branch may be edited back to having no geofence or region', async () => {
    // This used to be refused, mirroring the old activation rule. Once
    // activation stopped demanding coordinates (client, 28 Nov) the guard
    // became a trap: every ordinary save on a branch she had just been allowed
    // to open — a city correction, a phone number — would have failed with
    // "An active branch must keep latitude, longitude configured".
    await prisma.store.create({
      data: {
        id: A.unfenced,
        organisationId: A.org,
        name: 'Indore Ratnamani Complex',
        city: 'Indore',
        regionId: A.region,
        latitude: '22.7196000',
        longitude: '75.8577000',
        status: 'active',
        isActive: true,
      },
    });

    for (const body of [{ latitude: null }, { longitude: null }, { regionId: '' }]) {
      const res = await request(app.getHttpServer())
        .patch(`/stores/${A.unfenced}`)
        .set(auth(hoToken))
        .send(body);
      expect(res.status).toBe(200);
    }

    const edited = await prisma.store.findUniqueOrThrow({ where: { id: A.unfenced } });
    expect(edited).toMatchObject({
      status: 'active',
      isActive: true,
      latitude: null,
      longitude: null,
      regionId: null,
    });

    // And the gap keeps being reported on the branch itself, which is now the
    // only thing that ever mentions it.
    const listed = await request(app.getHttpServer()).get('/stores').set(auth(hoToken));
    expect(listed.status).toBe(200);
    expect(
      (listed.body as Array<{ id: string; needsGeo: boolean; needsRegion: boolean }>).find(
        (s) => s.id === A.unfenced,
      ),
    ).toMatchObject({ needsGeo: true, needsRegion: true });

    // Gone on the way out: the sync readiness assertion further down lists
    // every branch with no coordinates, by exact name.
    await prisma.store.delete({ where: { id: A.unfenced } });
  });

  it('a branch with neither a geofence nor a region goes live anyway', async () => {
    /*
     * The report: the client could not activate INDORE RATNAMANI COMPLEX. The
     * screen said "Geofence missing" and "Region missing" and the toast said
     * "Could not activate this branch — it may still be missing details."
     * Her answer, 28 Nov: "for activation this shouldn't be there. Geofencing
     * could be set up later on when we want it. The store should at least be
     * activated without that geofence so that we can start operating on it."
     */
    await prisma.store.create({
      data: {
        id: A.unfenced,
        organisationId: A.org,
        name: 'Ratnamani Complex',
        city: 'Indore',
        status: 'pending',
        isActive: false,
      },
    });

    const res = await request(app.getHttpServer())
      .patch(`/stores/${A.unfenced}/activate`)
      .set(auth(hoToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'active',
      isActive: true,
      // Activated, and still honest about what it has not got.
      needsGeo: true,
      needsRegion: true,
    });
    expect(await prisma.store.findUniqueOrThrow({ where: { id: A.unfenced } })).toMatchObject({
      status: 'active',
      isActive: true,
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: A.org, action: 'store.activate', entityId: A.unfenced },
      }),
    ).toBe(1);

    await prisma.store.delete({ where: { id: A.unfenced } });
  });

  it('an attendance-only office with no coordinates at all goes live', async () => {
    // An office exists FOR attendance, so a missing geofence is the thing it
    // most wants filled in — and still not a reason to refuse to open it.
    // A missing region is not even a gap for it: it sells nothing, so it is in
    // no sales area's rollup by design.
    await prisma.store.create({
      data: {
        id: A.unfencedOffice,
        organisationId: A.org,
        name: 'Indore Back Office',
        city: 'Indore',
        attendanceOnly: true,
        status: 'pending',
        isActive: false,
      },
    });

    const res = await request(app.getHttpServer())
      .patch(`/stores/${A.unfencedOffice}/activate`)
      .set(auth(hoToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'active',
      isActive: true,
      needsGeo: true,
      needsRegion: false,
    });

    await prisma.store.delete({ where: { id: A.unfencedOffice } });
  });

  it('two activates racing yield exactly one activation and one audit entry', async () => {
    // The lifecycle claim is the only thing standing between a double-click and
    // two activation events. It used to repeat the geofence and region
    // conditions as well, which is how the second attempt on a branch with no
    // coordinates came back as "Branch details changed while it was being
    // activated" — about a branch nobody had touched.
    await prisma.store.create({
      data: {
        id: A.activateRace,
        organisationId: A.org,
        name: 'Activate Race Branch',
        city: 'Indore',
        status: 'pending',
        isActive: false,
      },
    });

    const originalTransaction = (prisma.$transaction as any).bind(prisma);
    let rivalActivated = false;
    const transactionSpy: jest.SpyInstance = jest.spyOn(prisma as any, '$transaction');
    transactionSpy.mockImplementation(async (...args: any[]) => {
      if (!rivalActivated && typeof args[0] === 'function') {
        rivalActivated = true;
        await prisma.store.update({
          where: { id: A.activateRace },
          data: { status: 'active', isActive: true },
        });
      }
      return originalTransaction(...args);
    });

    try {
      const res = await request(app.getHttpServer())
        .patch(`/stores/${A.activateRace}/activate`)
        .set(auth(hoToken));
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toMatch(/opened or closed/i);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(rivalActivated).toBe(true);
    expect(await prisma.store.findUniqueOrThrow({ where: { id: A.activateRace } })).toMatchObject({
      status: 'active',
      isActive: true,
    });
    // The loser wrote nothing, audit included.
    expect(
      await prisma.auditLog.count({
        where: { organisationId: A.org, action: 'store.activate', entityId: A.activateRace },
      }),
    ).toBe(0);

    await prisma.store.delete({ where: { id: A.activateRace } });
  });

  it('an active attendance-only office can be edited without assigning a sales region', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/stores/${A.office}`)
      .set(auth(hoToken))
      .send({ city: 'Goregaon' });

    expect(res.status).toBe(200);
    expect(await prisma.store.findUniqueOrThrow({ where: { id: A.office } })).toMatchObject({
      city: 'Goregaon',
      attendanceOnly: true,
      regionId: null,
      status: 'active',
      isActive: true,
    });
  });

  it('a stale pending edit cannot clear geofence after activation wins the race', async () => {
    await prisma.store.create({
      data: {
        id: A.pendingRace,
        organisationId: A.org,
        name: 'Pending Race Branch',
        city: 'Mumbai',
        regionId: A.region,
        latitude: '19.2000000',
        longitude: '72.8000000',
        status: 'pending',
        isActive: false,
      },
    });

    const originalTransaction = (prisma.$transaction as any).bind(prisma);
    let activationInjected = false;
    const transactionSpy: jest.SpyInstance = jest.spyOn(prisma as any, '$transaction');
    transactionSpy.mockImplementation(async (...args: any[]) => {
      if (!activationInjected && typeof args[0] === 'function') {
        activationInjected = true;
        await prisma.store.update({
          where: { id: A.pendingRace },
          data: { status: 'active', isActive: true },
        });
      }
      return originalTransaction(...args);
    });

    try {
      const res = await request(app.getHttpServer())
        .patch(`/stores/${A.pendingRace}`)
        .set(auth(hoToken))
        .send({ latitude: null });
      expect(res.status).toBe(409);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(activationInjected).toBe(true);
    const raced = await prisma.store.findUniqueOrThrow({ where: { id: A.pendingRace } });
    expect(raced).toMatchObject({ status: 'active', isActive: true });
    expect(Number(raced.latitude)).toBeCloseTo(19.2, 6);
  });

  it('a closed branch reopens through the activation endpoint, geofence or no geofence', async () => {
    await prisma.store.update({
      where: { id: A.active2 },
      data: { status: 'closed', isActive: false, latitude: null, longitude: null },
    });

    // Closed is a soft state, and reopening is held to the same rule as a first
    // activation — which since 28 Nov does not include a geofence. A shop back
    // from a refit must not be kept shut over coordinates nobody has typed in.
    const reopened = await request(app.getHttpServer())
      .patch(`/stores/${A.active2}/activate`)
      .set(auth(hoToken));
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'active', needsGeo: true });
    expect(await prisma.store.findUniqueOrThrow({ where: { id: A.active2 } })).toMatchObject({
      status: 'active',
      isActive: true,
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: A.org, action: 'store.activate', entityId: A.active2 },
      }),
    ).toBeGreaterThan(0);

    // Reopening an already-open branch is a conflict, not a second event.
    const again = await request(app.getHttpServer())
      .patch(`/stores/${A.active2}/activate`)
      .set(auth(hoToken));
    expect(again.status).toBe(409);

    // Put its coordinates back: the sync readiness assertion further down lists
    // every branch that has none, by exact name.
    await prisma.store.update({
      where: { id: A.active2 },
      data: { latitude: 19.07, longitude: 72.87 },
    });
  });

  it('an area manager cannot edit a same-tenant branch outside their assigned scope', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/stores/${A.active2}`)
      .set(auth(areaManagerToken))
      .send({ city: 'Out-of-scope edit' });

    expect([403, 404]).toContain(res.status);
    expect(
      await prisma.store.findUniqueOrThrow({ where: { id: A.active2 }, select: { city: true } }),
    ).toEqual({ city: 'Second City' });
  });

  it('an area manager cannot move their assigned branch into another region to expand scope', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/stores/${A.active}`)
      .set(auth(areaManagerToken))
      .send({ regionId: A.otherRegion });

    expect(res.status).toBe(403);
    expect(String(res.body.message)).toMatch(/head office|region/i);
    expect(
      await prisma.store.findUniqueOrThrow({ where: { id: A.active }, select: { regionId: true } }),
    ).toEqual({ regionId: A.region });
  });

  it('sales-side writes reject a closed branch but serve a pending one', async () => {
    await prisma.store.update({
      where: { id: A.active2 },
      data: { status: 'closed', isActive: false },
    });

    const closedBefore = await prisma.checkIn.count({ where: { storeId: A.active2 } });
    const closed = await request(app.getHttpServer())
      .post('/checkins')
      .set(auth(hoToken))
      .send({ storeId: A.active2, customerName: 'Must Not Use Closed Branch' });
    expect(closed.status).toBe(400);
    expect(String(closed.body.message)).toMatch(/closed/i);
    expect(await prisma.checkIn.count({ where: { storeId: A.active2 } })).toBe(closedBefore);

    // Pending means head office has not reviewed the geofence and region yet.
    // Gati creates every branch it discovers that way, and that shop is already
    // selling, so refusing its walk-ins would shut a real counter.
    const pending = await request(app.getHttpServer())
      .post('/checkins')
      .set(auth(hoToken))
      .send({ storeId: A.pending, customerName: 'Pending Branch Still Trades' });
    expect(pending.status).toBe(201);
    expect(await prisma.checkIn.count({ where: { storeId: A.pending } })).toBe(1);
  });

  it('a region from another organisation is rejected and leaves the store unchanged', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/stores/${A.pending}`)
      .set(auth(hoToken))
      .send({ regionId: B.region });

    expect(res.status).toBe(400);
    const unchanged = await prisma.store.findUniqueOrThrow({ where: { id: A.pending } });
    expect(unchanged.regionId).toBeNull();
  });

  it('another tenant using the same visible branch code does not block store creation', async () => {
    const res = await request(app.getHttpServer())
      .post('/stores')
      .set(auth(hoToken))
      .send({
        name: 'Local Shared Code',
        city: 'Mumbai',
        code: 'shared-branch-code',
        regionId: A.region,
        latitude: 19.11,
        longitude: 72.88,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'shared-branch-code', status: 'active' });
    expect(res.body.id).not.toBe(B.sharedCodeStore);
  });

  it('store sync excludes holding rows from readiness counts and missing-geo results', async () => {
    // The activation test deliberately gave the bucket coordinates to prove the
    // holding flag itself blocks activation. Clear them again so this assertion
    // would catch a missing `isHolding=false` predicate in missingGeo as well.
    await prisma.store.update({
      where: { id: `unassigned:${A.org}` },
      data: { latitude: null, longitude: null, regionId: null },
    });

    const res = await request(app.getHttpServer())
      .post('/sync/stores')
      .set(asAgent())
      .send({ records: [{ legacyId: A.newLegacy, name: 'New Review Branch', city: 'Review City' }] });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    // The old pending branch plus the newly discovered branch. The holding row
    // is also status=pending, but it is not a branch awaiting activation.
    expect(res.body.pendingCount).toBe(2);
    expect((res.body.missingGeo as Array<{ id: string }>).map((s) => s.id).sort()).toEqual(
      [A.pending, res.body.created[0].id].sort(),
    );
    expect(JSON.stringify(res.body.missingGeo)).not.toContain('Unassigned');
  });

  it('later sync preserves an active reviewed profile but refreshes an unreviewed pending branch', async () => {
    await prisma.store.update({
      where: { id: A.active2 },
      data: { status: 'closed', isActive: false },
    });
    const res = await request(app.getHttpServer())
      .post('/sync/stores')
      .set(asAgent())
      .send({
        records: [
          {
            legacyId: 'STORE-HOLDING-ACTIVE',
            name: 'Incoming Active Name',
            city: 'Incoming Active City',
            code: 'INCOMING-ACTIVE',
            addressLine1: 'Incoming active address',
          },
          {
            legacyId: 'STORE-HOLDING-PENDING',
            name: 'Refreshed Pending Branch',
            city: 'Refreshed Pending City',
            code: 'REFRESHED-PENDING',
            addressLine1: 'Refreshed pending address',
          },
          {
            legacyId: 'STORE-HOLDING-ACTIVE-2',
            name: 'Incoming Closed Name',
            city: 'Incoming Closed City',
          },
        ],
      });
    expect(res.status).toBe(201);

    const active = await prisma.store.findUniqueOrThrow({ where: { id: A.active } });
    expect(active).toMatchObject({
      name: 'Reviewed Active Branch',
      city: 'Reviewed City',
      code: 'REVIEWED-ACTIVE',
      addressLine1: 'Reviewed address',
      status: 'active',
      isActive: true,
      regionId: A.region,
    });
    expect(Number(active.latitude)).toBeCloseTo(19.06514, 6);
    expect(Number(active.longitude)).toBeCloseTo(72.8307538, 6);

    const closed = await prisma.store.findUniqueOrThrow({ where: { id: A.active2 } });
    expect(closed).toMatchObject({
      name: 'Second Active Branch',
      city: 'Second City',
      status: 'closed',
      isActive: false,
    });

    const pending = await prisma.store.findUniqueOrThrow({ where: { id: A.pending } });
    expect(pending).toMatchObject({
      name: 'Refreshed Pending Branch',
      city: 'Refreshed Pending City',
      code: 'REFRESHED-PENDING',
      addressLine1: 'Refreshed pending address',
      status: 'pending',
      isActive: false,
    });
  });
});

async function teardown(prisma?: PrismaService) {
  if (!prisma) return;
  const organisationId = { in: [A.org, B.org] };

  // A walk-in resolves a customer, which brings a contact point, an activity
  // entry and possibly a merge candidate with it. Children before parents.
  await prisma.checkIn.deleteMany({ where: { store: { organisationId } } });
  await prisma.activityEvent.deleteMany({ where: { organisationId } });
  await prisma.productInteraction.deleteMany({ where: { organisationId } });
  await prisma.notification.deleteMany({ where: { user: { organisationId } } });
  await prisma.contactPoint.deleteMany({ where: { organisationId } });
  await prisma.mergeCandidate.deleteMany({ where: { organisationId } });
  await prisma.lead.deleteMany({ where: { organisationId } });
  await prisma.party.deleteMany({ where: { organisationId } });
  await prisma.syncState.deleteMany({ where: { organisationId } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId } } });
  await prisma.auditLog.deleteMany({ where: { organisationId } });
  await prisma.connectAgent.deleteMany({ where: { organisationId } });
  await prisma.user.deleteMany({ where: { organisationId } });
  await prisma.store.deleteMany({ where: { organisationId } });
  await prisma.region.deleteMany({ where: { organisationId } });
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
}
