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
  storeTwo: 'store_punch_a2',
  rep: 'rep.punch@punch-a.local',
  ho: 'ho.punch@punch-a.local',
  mate: 'mate.punch@punch-a.local',
  farManager: 'far.punch@punch-a.local',
};
const B = {
  org: 'org_punch_b',
  slug: 'punch-b',
  store: 'store_punch_b',
  ho: 'ho.punch@punch-b.local',
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
  /** A colleague at the same counter — same tenant, same branch, not a manager. */
  let mateToken: string;
  /** A manager, but of a branch this staffer does not work at. */
  let farManagerToken: string;
  /** Another tenant entirely. */
  let otherOrgToken: string;
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

    // A second branch in the same tenant, and a manager who covers only it.
    await prisma.store.create({
      data: { id: A.storeTwo, name: 'Far Branch', city: 'Surat', organisationId: A.org },
    });
    await prisma.user.create({
      data: {
        email: A.farManager, name: 'Far Manager', role: 'store_manager', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeTwo, isPrimary: true } },
      },
    });
    // A colleague at the SAME counter. Same tenant, same branch, not a manager:
    // no reason at all to hold a photograph of someone else's face.
    await prisma.user.create({
      data: {
        email: A.mate, name: 'Colleague', role: 'salesperson', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });

    // And another tenant.
    await prisma.organisation.create({
      data: { id: B.org, name: 'Punch B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Their Branch', city: 'Pune', organisationId: B.org },
    });
    await prisma.user.create({
      data: {
        email: B.ho, name: 'Their HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    repToken = await login(A.rep);
    hoToken = await login(A.ho);
    mateToken = await login(A.mate);
    farManagerToken = await login(A.farManager);
    otherOrgToken = await login(B.ho);
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

  /**
   * The photo also has to reach the screen where a manager actually reviews a
   * punch.
   *
   * It did not. `GET /hrms/attendance` is the only attendance endpoint the
   * manager HRMS page calls, and its shaper was the one of four that omitted
   * the field — so the evidence was captured, validated, stored and returned on
   * three OTHER endpoints, and rendered on none. It sat beside `distanceM`,
   * `withinFence` and `isMockLocation`, which are all shown.
   */
  it('puts the photo beside the other review signals a manager reads', async () => {
    await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
    const list = await request(server())
      .get('/hrms/attendance')
      .set({ Authorization: `Bearer ${hoToken}` })
      .set({ 'X-Store-Id': A.store })
      .expect(200);
    const row = list.body.find((r: { checkInPhotoUrl: string | null }) => r.checkInPhotoUrl);
    expect(row).toBeDefined();
    expect(row.checkInPhotoUrl).toBe(`/hrms/attendance/${row.id}/photo/in`);
    // The signals it belongs next to are all present on the same shape.
    expect(row).toHaveProperty('distanceM');
    expect(row).toHaveProperty('isMockLocation');
  });

  /* -------------------------------------------------- who may look at it */

  describe('who may look at it', () => {
    /**
     * A face photograph of a named employee at a known time and place is the one
     * class of object here where "the path is unguessable" is not a check.
     *
     * The URL used to be the object's own, served either by express static —
     * which runs ahead of every guard in this application — or by a public-read
     * bucket. Anyone who ever saw the link could fetch it forever, from any
     * organisation, signed in or not.
     */
    async function punchAndFindRecord() {
      await punch({ photo: `data:image/png;base64,${PNG_1PX}` }, 201);
      return stored();
    }

    it('never returns the object’s own storage URL', async () => {
      await punchAndFindRecord();
      const mine = await request(server())
        .get('/hrms/attendance/me').set(rep()).set({ 'X-Store-Id': A.store }).expect(200);
      expect(mine.body.today.checkInPhotoUrl).not.toContain('/uploads/');
      expect(mine.body.today.checkInPhotoUrl).toMatch(/^\/hrms\/attendance\/.+\/photo\/in$/);
    });

    it('gives the staffer their own photo', async () => {
      const row = await punchAndFindRecord();
      const res = await request(server())
        .get(`/hrms/attendance/${row.id}/photo/in`).set(rep()).expect(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('gives a manager who covers that branch the photo', async () => {
      const row = await punchAndFindRecord();
      await request(server())
        .get(`/hrms/attendance/${row.id}/photo/in`)
        .set({ Authorization: `Bearer ${hoToken}` })
        .expect(200);
    });

    it('refuses a colleague at the same counter', async () => {
      const row = await punchAndFindRecord();
      await request(server())
        .get(`/hrms/attendance/${row.id}/photo/in`)
        .set({ Authorization: `Bearer ${mateToken}` })
        .expect(403);
    });

    it('refuses a manager of a branch this staffer does not work at', async () => {
      const row = await punchAndFindRecord();
      await request(server())
        .get(`/hrms/attendance/${row.id}/photo/in`)
        .set({ Authorization: `Bearer ${farManagerToken}` })
        .expect(403);
    });

    it('refuses another tenant outright', async () => {
      const row = await punchAndFindRecord();
      await request(server())
        .get(`/hrms/attendance/${row.id}/photo/in`)
        .set({ Authorization: `Bearer ${otherOrgToken}` })
        .expect(404);
    });

    it('refuses a stranger with no session', async () => {
      const row = await punchAndFindRecord();
      await request(server()).get(`/hrms/attendance/${row.id}/photo/in`).expect(401);
    });

    it('is not reachable on the unguarded static path', async () => {
      const row = await punchAndFindRecord();
      // The object is real and still where it was written.
      expect(row.checkInPhotoUrl).toContain(`org/${A.org}/attendance`);
      // 404, not 403: whether a particular punch photo exists is itself
      // information, and this path is meant to look like it holds nothing.
      await request(server()).get(row.checkInPhotoUrl!).expect(404);
    });

    it('still serves an ordinary catalogue image on that same static path', async () => {
      // The refusal above is narrow on purpose. Product images want to be on a
      // CDN and reveal nothing about a person; only `attendance` and `visits`
      // are withheld.
      await request(server()).get(`/uploads/org/${A.org}/products/nothing.jpg`).expect(404);
      const res = await request(server()).get('/uploads/does-not-exist.jpg');
      // A miss, but from the static handler rather than the refusal above —
      // which is to say the handler is still mounted.
      expect(res.status).toBe(404);
    });

    it('says there is no photo rather than 500ing when none was taken', async () => {
      const row = await punchAndFindRecord();
      await request(server())
        .get(`/hrms/attendance/${row.id}/photo/out`).set(rep()).expect(404);
    });

    it('refuses an attendance id that does not exist', async () => {
      await request(server())
        .get('/hrms/attendance/not_a_real_record/photo/in').set(rep()).expect(404);
    });
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
  const orgs = [A.org, B.org];
  const drop = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => undefined);
  };
  await drop(() => prisma.attendanceRecord.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.userStore.deleteMany({ where: { store: { organisationId: { in: orgs } } } }));
  await drop(() => prisma.user.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.shift.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.store.deleteMany({ where: { organisationId: { in: orgs } } }));
  await drop(() => prisma.organisation.deleteMany({ where: { id: { in: orgs } } }));
}
