import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Per-person geolocation exemption (client, 9 Oct).
 *
 * A traveller or remote worker punches without a fence check: no reason
 * demanded, the row records WAIVED (never verified), nothing lands in the
 * off-site review trail. Everyone else stays held to the fence, and only
 * head office can grant or lift the exemption.
 */
const A = {
  org: 'org_geoex',
  slug: 'geoex',
  store: 'store_geoex',
  ho: 'ho.geoex@geoex.local',
  rep: 'rep.geoex@geoex.local',
};
const PASSWORD = 'password123';
const STORE_LAT = 19.06;
const STORE_LNG = 72.83;
// ~1.1 km north — far outside a 150 m fence.
const FAR = { lat: STORE_LAT + 0.01, lng: STORE_LNG };

async function teardown(prisma: PrismaService) {
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Geolocation exemption (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoT = '';
  let repT = '';

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'GeoEx Jewels', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: {
        id: A.store, name: 'Fenced', city: 'Mumbai', organisationId: A.org,
        latitude: STORE_LAT, longitude: STORE_LNG, geofenceRadiusM: 150,
        timezone: 'Asia/Kolkata',
      },
    });
    await prisma.user.create({
      data: {
        id: 'u_geoex_ho', email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        id: 'u_geoex_rep', email: A.rep, name: 'Traveller', role: 'salesperson', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token as string;
    hoT = await login(A.ho);
    repT = await login(A.rep);
  }, 120_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('held to the fence: a far punch with no reason is refused', async () => {
    const res = await request(server())
      .post('/hrms/attendance/check-in')
      .set(auth(repT))
      .send({ lat: FAR.lat, lng: FAR.lng });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/reason/i);
  });

  it('only head office grants the exemption', async () => {
    await request(server())
      .patch('/users/u_geoex_rep/location-check')
      .set(auth(repT))
      .send({ required: false })
      .expect(403);
    const res = await request(server())
      .patch('/users/u_geoex_rep/location-check')
      .set(auth(hoT))
      .send({ required: false })
      .expect(200);
    expect(res.body.geoExempt).toBe(true);
  });

  it('exempt: the same far punch records waived, unflagged, with no reason asked', async () => {
    await request(server())
      .post('/hrms/attendance/check-in')
      .set(auth(repT))
      .send({ lat: FAR.lat, lng: FAR.lng })
      .expect(201);

    const row = await prisma.attendanceRecord.findFirst({
      where: { organisationId: A.org, staffId: 'u_geoex_rep' },
    });
    expect(row?.geoWaived).toBe(true);
    // Waived is not verified — the register never pretends the fence was checked.
    expect(row?.geoVerified).toBe(false);

    // And nothing in the off-site review trail.
    const offsite = await prisma.auditLog.count({
      where: { organisationId: A.org, action: 'attendance.offsite_punch' },
    });
    expect(offsite).toBe(0);
  });

  it('the exemption can be lifted again, audited both ways', async () => {
    const res = await request(server())
      .patch('/users/u_geoex_rep/location-check')
      .set(auth(hoT))
      .send({ required: true })
      .expect(200);
    expect(res.body.geoExempt).toBe(false);
    const audits = await prisma.auditLog.count({
      where: { organisationId: A.org, action: 'users.location_check_set' },
    });
    expect(audits).toBe(2);
  });
});
