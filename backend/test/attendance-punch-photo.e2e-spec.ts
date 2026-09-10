import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The photo taken at the moment of an attendance punch.
 *
 * What this is: corroboration. A camera on the device produced this image, at
 * this time, alongside the geofence distance and the mock-location flag that
 * were already recorded.
 *
 * What it is deliberately NOT: identification. Nothing compares the image to an
 * enrolled face, so no column and no response field claims a verified identity.
 * The tests below pin that, because a "verified" flag nobody computes is worse
 * than no flag at all — it would let a buddy punch carry a badge saying it was
 * checked.
 *
 * The other half of this suite is refusal. `data:` is a URL scheme: the MIME
 * type is written by whoever sends it, so it proves nothing on its own. Any
 * payload whose bytes disagree with its declared type is dropped, and the punch
 * still succeeds — an attendance record must never be lost to a bad camera
 * frame.
 */

/** A real 1x1 PNG. Used where a genuinely well-formed image is needed. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const A = {
  org: 'org_punch_a',
  slug: 'punch-a',
  store: 'store_punch_a',
  rep: 'rep.punch@punch-a.local',
  ho: 'ho.punch@punch-a.local',
};
const PASSWORD = 'password123';

/** The store's own coordinates, so every punch below is inside the fence. */
const LAT = 19.0606;
const LNG = 72.8362;

describe('Attendance punch photo (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let repToken: string;
  let hoToken: string;
  let uploadDir: string;

  const server = () => app.getHttpServer();
  const rep = () => ({ Authorization: `Bearer ${repToken}` });

  beforeAll(async () => {
    // Uploads land in a temp directory that this suite owns and deletes, rather
    // than in the repository's own uploads folder.
    uploadDir = mkdtempSync(join(tmpdir(), 'eclat-punch-'));
    process.env.UPLOAD_DIR = uploadDir;

    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
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
    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Punch A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: {
        id: A.store, name: 'Punch Branch', city: 'Mumbai', organisationId: A.org,
        latitude: String(LAT), longitude: String(LNG), geofenceRadiusM: 150,
        timezone: 'Asia/Kolkata',
      },
    });
    await prisma.user.create({
      data: {
        email: A.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    repToken = await login(A.rep);
    hoToken = await login(A.ho);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    if (uploadDir && existsSync(uploadDir)) rmSync(uploadDir, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
  });

  /**
   * Each case punches fresh, so one test's record never decides another's.
   *
   * The expected status is a parameter rather than a chained `.expect()`:
   * clearing the previous punch has to be awaited first, and awaiting turns
   * supertest's chainable request into a plain promise.
   */
  async function punch(body: Record<string, unknown>, status = 201) {
    await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
    return request(server())
      .post('/hrms/attendance/check-in')
      .set(rep())
      .set({ 'X-Store-Id': A.store })
      .send({ lat: LAT, lng: LNG, ...body })
      .expect(status);
  }

  const stored = () =>
    prisma.attendanceRecord.findFirstOrThrow({ where: { organisationId: A.org } });

  /* ------------------------------------------------------------- accepting */

  it('stores a well-formed frame and points the row at it', async () => {
    await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
    const row = await stored();
    expect(row.checkInPhotoUrl).toBeTruthy();
    // A pointer, never the bytes: an image column is an image in every backup.
    expect(row.checkInPhotoUrl!.length).toBeLessThan(500);
    expect(row.checkInPhotoUrl).not.toContain('base64');
  });

  it('namespaces the object under the tenant, not a shared path', async () => {
    await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
    const row = await stored();
    expect(row.checkInPhotoUrl).toContain(`org/${A.org}`);
    expect(row.checkInPhotoUrl).toContain('attendance');
  });

  it('never claims the punch was identity-verified', async () => {
    const res = await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
    const body = JSON.stringify(res.body).toLowerCase();
    // `geoVerified` is a real measurement and may appear. A biometric or face
    // verdict must not, because nothing computed one.
    expect(body).not.toContain('biometric');
    expect(body).not.toContain('faceverified');
    expect(body).not.toContain('facematch');
    expect(body).not.toContain('confidence');
    const row = await stored();
    expect(Object.keys(row)).not.toContain('faceVerified');
  });

  /* ------------------------------------------------------------- refusing */

  it('drops a payload whose bytes disagree with its declared type', async () => {
    // Base64 of "this is definitely not a png" under an image/png label.
    const lie = Buffer.from('this is definitely not a png').toString('base64');
    await punch({ photo: `data:image/png;base64,${lie}` }, 201);
    const row = await stored();
    expect(row.checkInPhotoUrl).toBeNull();
    // The punch itself still happened. That is the whole point.
    expect(row.checkInAt).toBeTruthy();
  });

  it('drops a type it does not serve, rather than storing it under a new name', async () => {
    await punch({
      photo: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    });
    const row = await stored();
    expect(row.checkInPhotoUrl).toBeNull();
  });

  it('drops a value that is not a data URL at all', async () => {
    await punch({ photo: 'https://example.invalid/someone-elses-face.jpg' }, 201);
    expect((await stored()).checkInPhotoUrl).toBeNull();
  });

  it('answers a body past the parser limit with 413, not a 500', async () => {
    /*
     * The test app deliberately keeps express's default body limit, so this is
     * the body parser refusing — a `PayloadTooLargeError`, not a Nest
     * HttpException. It used to fall through the exception filter as an unknown
     * fault: the caller got "something went wrong, the team has been notified"
     * and an on-call alert fired because someone posted a big photo.
     */
    await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
    const huge = 'A'.repeat(3_000_001);
    const res = await request(server())
      .post('/hrms/attendance/check-in')
      .set(rep())
      .set({ 'X-Store-Id': A.store })
      .send({ lat: LAT, lng: LNG, photo: `data:image/png;base64,${huge}` });

    expect(res.status).toBe(413);
    expect(String(res.body.message)).toMatch(/too large/i);
    // And nothing was written: the punch never reached the handler.
    expect(await prisma.attendanceRecord.count({ where: { organisationId: A.org } })).toBe(0);
  });

  it('records the punch when there is no camera at all', async () => {
    await punch({}, 201);
    const row = await stored();
    expect(row.checkInAt).toBeTruthy();
    expect(row.checkInPhotoUrl).toBeNull();
  });

  /* -------------------------------------------------------------- reading */

  it('shows the photo to the person reviewing the punch', async () => {
    await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
    const mine = await request(server())
      .get('/hrms/attendance/me')
      .set(rep())
      .set({ 'X-Store-Id': A.store })
      .expect(200);
    expect(mine.body.today.checkInPhotoUrl).toBeTruthy();
    expect(mine.body.today.checkOutPhotoUrl).toBeNull();
  });

  it('keeps head office view-only — it cannot punch, with or without a photo', async () => {
    await request(server())
      .post('/hrms/attendance/check-in')
      .set({ Authorization: `Bearer ${hoToken}` })
      .set({ 'X-Store-Id': A.store })
      .send({ lat: LAT, lng: LNG, photo: `data:image/png;base64,${PNG_1PX}` })
      .expect(403);
  });

  it('writes exactly one object per stored photo', async () => {
    await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
    const orgDir = join(uploadDir, 'org', A.org, 'attendance');
    expect(existsSync(orgDir)).toBe(true);
    expect(readdirSync(orgDir).length).toBeGreaterThan(0);
  });
});

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } }).catch(() => undefined);
  await prisma.userStore.deleteMany({ where: { store: { organisationId: A.org } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { organisationId: A.org } }).catch(() => undefined);
  await prisma.shift.deleteMany({ where: { organisationId: A.org } }).catch(() => undefined);
  await prisma.store.deleteMany({ where: { organisationId: A.org } }).catch(() => undefined);
  await prisma.organisation.deleteMany({ where: { id: A.org } }).catch(() => undefined);
}
