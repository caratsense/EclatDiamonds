import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import { tmpdir } from 'os';
import { join } from 'path';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { JobsService } from '../src/jobs/jobs.service';
import { safeEntryName } from '../src/products/catalogue-export.service';
import { isPrivateUploadPath } from '../src/storage/private-media';

/**
 * Head office takes the catalogue's photographs away as one ZIP.
 *
 *  1. HEAD OFFICE ONLY, AND ONLY ITS OWN TENANT. Another tenant's export id is
 *     not found — not forbidden, not found.
 *
 *  2. A GENUINE ZIP, with a manifest mapping every file to SKU, style number,
 *     VIN and name, and every photograph that could not be included listed with
 *     the reason — in the manifest and in the job's result.
 *
 *  3. ENTRY NAMES CANNOT ESCAPE THE FOLDER, however hostile the SKU.
 *
 *  4. LIMITS REFUSE, THEY NEVER TRIM. Over the file count is a 400 up front, or a
 *     failed job with the reason if the catalogue grew after the request; over
 *     the byte limit is a failed job. No partial archive is left behind.
 *
 *  5. IT RUNS ON THE BACKGROUND QUEUE, with pending / completed / failed state.
 *
 *  6. EMAIL THAT IS NOT CONFIGURED IS NOT REPORTED AS SENT, and the download
 *     still works.
 *
 *  7. WHO ASKED AND WHO DOWNLOADED ARE BOTH AUDITED.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_cx_a',
  slug: 'cx-a',
  store: 'store_cx_a',
  store2: 'store_cx_a2',
  ho: 'ho.cx@cx-a.local',
  mgr: 'mgr.cx@cx-a.local',
};
const B = { org: 'org_cx_b', slug: 'cx-b', store: 'store_cx_b', ho: 'ho.cx@cx-b.local' };

/** A 1x1 PNG. Real bytes, so the archive genuinely carries a photograph. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.jobTask.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.stockItem.deleteMany({ where: { organisationId: org } });
    await prisma.productEmbedding.deleteMany({ where: { product: { organisationId: org } } });
    await prisma.product.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Catalogue photo ZIP export (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let uploadDir: string;
  let hoT: string;
  let mgrT: string;
  let otherHoT: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A product whose photograph is really on disk (unless `imageUrl` says otherwise). */
  async function product(
    sku: string,
    opts: { org?: string; styleNumber?: string; name?: string; imageUrl?: string | null; storeId?: string } = {},
  ) {
    const org = opts.org ?? A.org;
    let imageUrl = opts.imageUrl;
    if (imageUrl === undefined) {
      const file = `${Math.random().toString(36).slice(2)}.png`;
      mkdirSync(join(uploadDir, 'org', org, 'catalogue'), { recursive: true });
      writeFileSync(join(uploadDir, 'org', org, 'catalogue', file), PNG);
      imageUrl = `/uploads/org/${org}/catalogue/${file}`;
    }
    return prisma.product.create({
      data: {
        organisationId: org,
        storeId: opts.storeId ?? (org === A.org ? A.store : B.store),
        sku,
        name: opts.name ?? `Product ${sku}`,
        styleNumber: opts.styleNumber,
        category: 'ring',
        metal: 'gold_22k',
        imageUrl,
      },
      select: { id: true },
    });
  }

  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    uploadDir = mkdtempSync(join(tmpdir(), 'eclat-cx-'));
    process.env.UPLOAD_DIR = uploadDir;
    // The test drives the queue itself; a scheduler tick must not race it.
    process.env.SCHEDULER_ENABLED = 'false';

    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { JobsService: J } = await import('../src/jobs/jobs.service');
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
    prisma = app.get(P);
    jobs = app.get(J);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const o of [A, B]) {
      await prisma.organisation.create({
        data: { id: o.org, name: o.slug, slug: o.slug, industryPackCode: 'jewellery' },
      });
    }
    await prisma.store.create({ data: { id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org } });
    await prisma.store.create({ data: { id: A.store2, name: 'Udaipur', city: 'Udaipur', organisationId: A.org } });
    await prisma.store.create({ data: { id: B.store, name: 'Other', city: 'Pune', organisationId: B.org } });
    const users: [string, string, string, string, string[]][] = [
      ['u_cx_ho', A.ho, 'head_office', A.org, [A.store, A.store2]],
      ['u_cx_mgr', A.mgr, 'store_manager', A.org, [A.store]],
      ['u_cx_ho_b', B.ho, 'head_office', B.org, [B.store]],
    ];
    for (const [id, email, role, org, stores] of users) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: org,
          userStores: { create: stores.map((storeId, i) => ({ storeId, isPrimary: i === 0 })) },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    otherHoT = await login(B.ho);

    // The catalogue under test.
    const ring = await product('RING-001', { styleNumber: 'ST-1', name: 'Solitaire ring' });
    await prisma.stockItem.create({
      data: {
        organisationId: A.org, storeId: A.store, productId: ring.id, sku: 'RING-001',
        status: 'in_stock', vin: '260000017',
      },
    });
    await product('ring-001', { styleNumber: 'ST-1' }); // same name on a case-insensitive disk
    await product('../../etc/passwd', { name: 'Traversal attempt' });
    await product('C:\\Windows\\win.ini', { name: 'Drive letter attempt' });
    await product('/abs/path', { name: 'Absolute path attempt' });
    await product('CON', { name: '=HYPERLINK("http://x")' });
    await product('MISSING-1', { imageUrl: `/uploads/org/${A.org}/catalogue/not-there.png` });
    await product('EXT-1', { imageUrl: 'https://example.com/photo.jpg' });
    await product('FOREIGN-1', { imageUrl: `/uploads/org/${B.org}/catalogue/theirs.png` });
    await product('NO-PHOTO', { imageUrl: null });
    await product('B-ONLY', { org: B.org });
  }, 180_000);

  afterAll(async () => {
    delete process.env.CATALOGUE_EXPORT_MAX_FILES;
    delete process.env.CATALOGUE_EXPORT_MAX_BYTES;
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.UPLOAD_DIR;
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
  });

  it('entry names are safe whatever the SKU says', () => {
    const taken = new Set<string>();
    const names = [
      safeEntryName('../../etc/passwd', 'png', taken),
      safeEntryName('..\\..\\boot.ini', 'png', taken),
      safeEntryName('C:\\Windows\\win.ini', 'png', taken),
      safeEntryName('/abs/path', 'png', taken),
      safeEntryName('CON', 'png', taken),
      safeEntryName('', 'png', taken),
      safeEntryName('RING-1', 'jpg', taken),
      safeEntryName('ring-1', 'jpg', taken),
      safeEntryName('..', '', taken),
    ];
    for (const n of names) {
      expect(n).not.toMatch(/\.\./);
      expect(n).not.toMatch(/[\\/:]/);
      expect(n).not.toMatch(/^\s|^\./);
      expect(n.length).toBeGreaterThan(0);
    }
    expect(names[4]).toBe('_CON.png');
    expect(names[5]).toBe('photo.png');
    // Case-insensitive de-duplication: extracting on Windows must not overwrite.
    expect(names[6]).toBe('RING-1.jpg');
    expect(names[7]).toBe('ring-1-2.jpg');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('the export folder is refused by the public static handler, however the path is spelt', () => {
    const blocked = [
      '/uploads/org/o1/exports/a.zip',
      '/uploads/org/o1/EXPORTS/a.zip',
      '/uploads/org/o1/%65xports/a.zip',
      '/uploads/org%2Fo1%2Fexports%2Fa.zip',
      '/uploads//org/o1/exports/a.zip',
      '/uploads/org/o1/./exports/a.zip',
      '/uploads/org/o1/attendance/p.jpg',
      '/uploads/org/o1/visits/p.jpg',
      '/uploads/org/o1/%E0%A4%A/bad-encoding',
    ];
    for (const p of blocked) expect([p, isPrivateUploadPath(p)]).toEqual([p, true]);
    // Catalogue photographs stay public, and a bad escape elsewhere is not this handler's business.
    for (const p of ['/uploads/org/o1/catalogue/x.png', '/catalogue-exports/%E0%A4%A']) {
      expect([p, isPrivateUploadPath(p)]).toEqual([p, false]);
    }
  });

  it('is refused to everyone but head office', async () => {
    await request(server()).post('/catalogue-exports').set(auth(mgrT)).send({}).expect(403);
    await request(server()).get('/catalogue-exports').set(auth(mgrT)).expect(403);
  });

  let exportId: string;

  it('a request is queued as a background job and is pending until the queue runs it', async () => {
    const res = await request(server()).post('/catalogue-exports').set(auth(hoT)).send({}).expect(201);
    exportId = res.body.id;
    expect(res.body.status).toBe('pending');
    expect(res.body.archive).toBeNull();

    const job = await prisma.jobTask.findUnique({ where: { id: exportId } });
    expect(job).toMatchObject({ kind: 'catalogue.export', status: 'pending', organisationId: A.org });

    // Not ready is a conflict, not an empty file.
    await request(server()).get(`/catalogue-exports/${exportId}/download`).set(auth(hoT)).expect(409);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'catalogue.export_requested', entityId: exportId },
    });
    expect(audit?.actorId).toBe('u_cx_ho');
  });

  it('completes on the queue and lists every skipped photograph with its reason', async () => {
    await jobs.drain(5);
    const res = await request(server()).get(`/catalogue-exports/${exportId}`).set(auth(hoT)).expect(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.archive.files).toBe(6);
    expect(res.body.archive.skippedCount).toBe(3);
    const reasons = Object.fromEntries(
      res.body.skipped.map((s: { sku: string; reason: string }) => [s.sku, s.reason]),
    );
    expect(reasons).toEqual({ 'MISSING-1': 'missing', 'EXT-1': 'external', 'FOREIGN-1': 'not_authorised' });
    // Nobody asked for email, so nothing claims one.
    expect(res.body.email).toBeNull();

    const list = await request(server()).get('/catalogue-exports').set(auth(hoT)).expect(200);
    expect(list.body.map((e: { id: string }) => e.id)).toContain(exportId);
  });

  it('downloads a genuine ZIP with a manifest, real photographs and safe names', async () => {
    const res = await binary(
      request(server()).get(`/catalogue-exports/${exportId}/download`).set(auth(hoT)),
    ).expect(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="catalogue-photos-/);

    const zip = await JSZip.loadAsync(res.body as Buffer);
    const files = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
    expect(files).toContain('manifest.csv');
    const photos = files.filter((f) => f.startsWith('photos/'));
    expect(photos).toHaveLength(6);
    for (const name of files) {
      expect(name.split('/')).not.toContain('..');
      expect(name).not.toMatch(/^[\\/]|^[a-zA-Z]:|\\/);
    }
    expect(new Set(photos.map((p) => p.toLowerCase())).size).toBe(6);
    expect(Buffer.compare(await zip.file(photos[0])!.async('nodebuffer'), PNG)).toBe(0);

    const manifest = (await zip.file('manifest.csv')!.async('string')).replace(/^\uFEFF/, '');
    const lines = manifest.trim().split('\r\n');
    expect(lines[0]).toBe('file,sku,style_number,vin,product_name,status,reason');
    // File name → SKU, style number, VIN, product name. Which of RING-001 and
    // ring-001 is written first depends on the database's collation, so the
    // second one's "-2" is checked by shape, not by which it landed on.
    expect(lines).toContainEqual(
      expect.stringMatching(/^photos\/RING-001(-2)?\.png,RING-001,ST-1,260000017,Solitaire ring,included,$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^photos\/ring-001(-2)?\.png,ring-001,ST-1,,/));
    // Skipped photographs are in the manifest too, with no file and the reason.
    expect(lines.find((l) => l.includes(',MISSING-1,'))).toMatch(/^,MISSING-1,.*,skipped,/);
    // A product name is somebody else's text: never a live formula in a spreadsheet.
    expect(manifest).toContain(`"'=HYPERLINK(""http://x"")"`);
    // The traversal SKU is in the manifest as data, with a harmless file name.
    expect(lines.find((l) => l.includes(',../../etc/passwd,'))).toMatch(/^photos\/[^,/\\]+\.png,/);

    const downloaded = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'catalogue.export_downloaded', entityId: exportId },
    });
    expect(downloaded?.actorId).toBe('u_cx_ho');
  });

  it('another tenant cannot see, read or download it', async () => {
    await request(server()).get(`/catalogue-exports/${exportId}`).set(auth(otherHoT)).expect(404);
    await request(server()).get(`/catalogue-exports/${exportId}/download`).set(auth(otherHoT)).expect(404);
    const list = await request(server()).get('/catalogue-exports').set(auth(otherHoT)).expect(200);
    expect(list.body.map((e: { id: string }) => e.id)).not.toContain(exportId);
    // And its own export never contains this tenant's photographs.
    const own = await request(server()).post('/catalogue-exports').set(auth(otherHoT)).send({}).expect(201);
    await jobs.drain(5);
    const done = await request(server()).get(`/catalogue-exports/${own.body.id}`).set(auth(otherHoT)).expect(200);
    expect(done.body.archive.files).toBe(1);
  });

  it('filters narrow the archive, and a branch outside scope is refused', async () => {
    const res = await request(server())
      .post('/catalogue-exports')
      .set(auth(hoT))
      .send({ code: 'st-1', category: 'ring', availability: 'in_stock', stockClass: 'standard' })
      .expect(201);
    await jobs.drain(5);
    const done = await request(server()).get(`/catalogue-exports/${res.body.id}`).set(auth(hoT)).expect(200);
    expect(done.body.archive.files).toBe(2);

    await request(server())
      .post('/catalogue-exports')
      .set(auth(hoT))
      .send({ updatedFrom: '2999-01-01' })
      .expect(400);
    await request(server())
      .post('/catalogue-exports')
      .set(auth(hoT))
      .send({ updatedFrom: '2026-02-01', updatedTo: '2026-01-01' })
      .expect(400);
    await request(server()).post('/catalogue-exports').set(auth(hoT)).send({ updatedFrom: 'yesterday' }).expect(400);
    await request(server()).post('/catalogue-exports').set(auth(hoT)).send({ storeId: B.store }).expect(403);
    // Nothing in the second branch has a photograph.
    await request(server()).post('/catalogue-exports').set(auth(hoT)).send({ storeId: A.store2 }).expect(400);
  });

  it('over the file limit is refused up front, never trimmed', async () => {
    process.env.CATALOGUE_EXPORT_MAX_FILES = '2';
    try {
      const res = await request(server()).post('/catalogue-exports').set(auth(hoT)).send({}).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/at most 2/);
    } finally {
      delete process.env.CATALOGUE_EXPORT_MAX_FILES;
    }
  });

  it('a catalogue that grows past the limit after the request fails the job, with no archive left', async () => {
    process.env.CATALOGUE_EXPORT_MAX_FILES = '2';
    try {
      await product('LIMIT-1');
      await product('LIMIT-2');
      const res = await request(server())
        .post('/catalogue-exports')
        .set(auth(hoT))
        .send({ code: 'LIMIT-' })
        .expect(201);
      await product('LIMIT-3');
      await jobs.drain(5);

      const done = await request(server()).get(`/catalogue-exports/${res.body.id}`).set(auth(hoT)).expect(200);
      expect(done.body.status).toBe('failed');
      expect(done.body.error).toMatch(/at most 2.*Nothing was written/);
      expect(done.body.archive).toBeNull();
      await request(server()).get(`/catalogue-exports/${res.body.id}/download`).set(auth(hoT)).expect(409);
      const dir = join(uploadDir, 'org', A.org, 'exports');
      expect(existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(res.body.id)) : []).toEqual([]);
    } finally {
      delete process.env.CATALOGUE_EXPORT_MAX_FILES;
    }
  });

  it('over the byte limit fails the job honestly', async () => {
    process.env.CATALOGUE_EXPORT_MAX_BYTES = String(PNG.length + 10);
    try {
      const res = await request(server())
        .post('/catalogue-exports')
        .set(auth(hoT))
        .send({ code: 'ST-1' })
        .expect(201);
      await jobs.drain(5);
      const done = await request(server()).get(`/catalogue-exports/${res.body.id}`).set(auth(hoT)).expect(200);
      expect(done.body.status).toBe('failed');
      expect(done.body.error).toMatch(/holds at most \d+ bytes/);
      const dir = join(uploadDir, 'org', A.org, 'exports');
      expect(readdirSync(dir).filter((f) => f.startsWith(res.body.id))).toEqual([]);
    } finally {
      delete process.env.CATALOGUE_EXPORT_MAX_BYTES;
    }
  });

  it('email that is not configured is reported as not sent, and the download still works', async () => {
    const res = await request(server())
      .post('/catalogue-exports')
      .set(auth(hoT))
      .send({ code: 'RING-001', emailMe: true })
      .expect(201);
    expect(res.body.emailRequested).toBe(true);
    await jobs.drain(5);
    const done = await request(server()).get(`/catalogue-exports/${res.body.id}`).set(auth(hoT)).expect(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.email.status).not.toMatch(/^sent/);
    await binary(request(server()).get(`/catalogue-exports/${res.body.id}/download`).set(auth(hoT))).expect(200);
  });
});
