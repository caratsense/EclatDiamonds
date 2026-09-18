import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { readFileSync } from 'fs';
import { join } from 'path';
import * as http from 'http';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * LIVE end-to-end: the REAL DINOv2 + SigLIP inference service (no mock).
 *
 * Proves the whole production path with real image data:
 *   upload → inference /embed → ProductEmbedding → vector search → TOP-10 ranked.
 *
 * Requires the inference service running (ML_INFERENCE_URL). It probes /health in
 * beforeAll and SKIPS cleanly when unreachable, so a normal CI run without the
 * service stays green — this spec only asserts when real inference is available.
 */
const INFER = process.env.ML_INFERENCE_URL || 'http://127.0.0.1:8123';
const PASSWORD = 'password123';
const HO = 'head.office@caratsense.in';
const MGR = 'aarav.mehta@caratsense.in'; // Surat store manager (sees surat-main)
const STORE = 'surat-main';
const IMGDIR = join(__dirname, '..', 'uploads', 'catalogue');
const IMAGES = ['1.jpg', '10.jpg', '101.jpg', '103.jpg'];
const PIDS = IMAGES.map((_, i) => `live-sim-${i + 1}`);
const SKUS = IMAGES.map((_, i) => `LIVE-SIM-${i + 1}`);

function healthOk(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${INFER}/health`, { timeout: 4000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          resolve(JSON.parse(d).status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

describe('Jewelry similarity — LIVE real DINOv2+SigLIP inference (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  let live = false;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (email: string) => {
    const r = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

  beforeAll(async () => {
    // Point the real MlInferenceService at the running service (no mock override).
    process.env.ML_INFERENCE_URL = INFER;
    live = await healthOk();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    if (!live) return; // nothing to seed if the service is down; tests will no-op.

    await cleanup(prisma);
    tokens.ho = await login(HO);
    tokens.mgr = await login(MGR);

    // Seed real, distinct catalogue images as org_eclat / Surat products.
    for (let i = 0; i < IMAGES.length; i++) {
      await prisma.product.upsert({
        where: { id: PIDS[i] },
        update: { imageUrl: `/uploads/catalogue/${IMAGES[i]}`, storeId: STORE, organisationId: 'org_eclat' },
        create: {
          id: PIDS[i],
          sku: SKUS[i],
          name: `Live Sim ${i + 1}`,
          metal: 'gold_22k',
          organisationId: 'org_eclat',
          storeId: STORE,
          imageUrl: `/uploads/catalogue/${IMAGES[i]}`,
          embedding: [],
        },
      });
    }
    await prisma.productEmbedding.deleteMany({ where: { productId: { in: PIDS } } });
  }, 120000);

  afterAll(async () => {
    if (prisma) await cleanup(prisma);
    await app?.close();
  });

  it('reindex builds REAL 768-dim embeddings for each product with an image', async () => {
    if (!live) return console.warn('[skipped] inference service not reachable');
    for (const pid of PIDS) {
      const r = await request(app.getHttpServer())
        .post(`/products/embeddings/reindex?productId=${pid}`)
        .set(auth(tokens.ho));
      expect(r.status).toBe(201);
      expect(r.body.available).toBe(true);
    }
    const rows = await prisma.productEmbedding.findMany({ where: { productId: { in: PIDS } } });
    // One whole-photo row per product; each detected piece adds an `<hash>#vN`
    // view row beside it.
    const whole = rows.filter((r) => !r.imageHash?.includes('#'));
    expect(whole.length).toBe(PIDS.length);
    expect(new Set(rows.map((r) => r.productId)).size).toBe(PIDS.length);
    for (const row of rows) {
      expect(row.dinoEmbedding.length).toBe(768);
      expect(row.siglipEmbedding.length).toBe(768);
      expect(row.organisationId).toBe('org_eclat'); // stamped to the caller's org
    }
  }, 120000);

  it('upload → TOP-10 genuinely ranked; the exact image ranks #1 (VERY_CLOSE)', async () => {
    if (!live) return console.warn('[skipped] inference service not reachable');
    const res = await request(app.getHttpServer())
      .post('/products/jewelry/similarity-search')
      .set(auth(tokens.mgr))
      .attach('file', readFileSync(join(IMGDIR, IMAGES[0])), { filename: IMAGES[0], contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.available).toBe(true);
    expect(res.body.status).toBe('MATCHES_FOUND');
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results.length).toBeLessThanOrEqual(10);
    // The uploaded image IS product #1 in the catalogue → it must rank first.
    expect(res.body.results[0].productId).toBe(PIDS[0]);
    expect(res.body.results[0].matchLevel).toBe('VERY_CLOSE');
    expect(res.body.results[0].sku).toBe(SKUS[0]);
    // Strictly descending by real similarity.
    const scores = res.body.results.map((r: any) => r.closenessScore);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    // No raw vectors leak to the client.
    expect(res.body.results[0].dinoEmbedding).toBeUndefined();
  }, 120000);

  it('another organisation’s IDENTICAL-image product never leaks into results', async () => {
    if (!live) return console.warn('[skipped] inference service not reachable');
    // A perfect-match adversary in a different org: same image, copied embedding.
    const match = await prisma.productEmbedding.findFirstOrThrow({ where: { productId: PIDS[0] } });
    await prisma.organisation.upsert({ where: { id: 'org_live_b' }, update: {}, create: { id: 'org_live_b', name: 'Live B', slug: 'live-b' } });
    await prisma.store.upsert({ where: { id: 'store_live_b' }, update: {}, create: { id: 'store_live_b', name: 'Live B Store', city: 'Testville', organisationId: 'org_live_b' } });
    await prisma.product.upsert({
      where: { id: 'p-live-b' },
      update: {},
      create: { id: 'p-live-b', sku: 'LIVE-B-1', name: 'Live B Ring', metal: 'gold_22k', organisationId: 'org_live_b', storeId: 'store_live_b', imageUrl: `/uploads/catalogue/${IMAGES[0]}`, embedding: [] },
    });
    await prisma.productEmbedding.create({
      data: {
        productId: 'p-live-b',
        organisationId: 'org_live_b',
        storeId: 'store_live_b',
        dinoEmbedding: match.dinoEmbedding,
        siglipEmbedding: match.siglipEmbedding,
        dinoModelVersion: match.dinoModelVersion,
        siglipModelVersion: match.siglipModelVersion,
        preprocessingVersion: match.preprocessingVersion,
        imageHash: match.imageHash,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/products/jewelry/similarity-search')
      .set(auth(tokens.mgr))
      .attach('file', readFileSync(join(IMGDIR, IMAGES[0])), { filename: IMAGES[0], contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    const ids = res.body.results.map((r: any) => r.productId);
    expect(ids).not.toContain('p-live-b'); // other org's perfect match is invisible
    expect(res.body.results[0].productId).toBe(PIDS[0]); // own-org match still #1

    await prisma.productEmbedding.deleteMany({ where: { organisationId: 'org_live_b' } });
    await prisma.product.deleteMany({ where: { organisationId: 'org_live_b' } });
    await prisma.store.deleteMany({ where: { organisationId: 'org_live_b' } });
    await prisma.organisation.deleteMany({ where: { id: 'org_live_b' } });
  }, 120000);
});

async function cleanup(prisma: PrismaService) {
  await prisma.productEmbedding.deleteMany({ where: { organisationId: 'org_live_b' } });
  await prisma.product.deleteMany({ where: { organisationId: 'org_live_b' } });
  await prisma.store.deleteMany({ where: { organisationId: 'org_live_b' } });
  await prisma.organisation.deleteMany({ where: { id: 'org_live_b' } });
  await prisma.productEmbedding.deleteMany({ where: { productId: { in: [...PIDS, 'p-live-b'] } } });
  await prisma.product.deleteMany({ where: { id: { in: PIDS } } });
}
