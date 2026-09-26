import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GOLD_RATE_JOB } from '../src/integrations/gold-rate.service';

/**
 * "Is anything still pulling the gold rate?"
 *
 * The rates screen could say how OLD a price was and nothing about WHY. Those
 * are different failures wearing the same face: a feed that returned nothing
 * this morning looks exactly like a scheduler that has not run since the last
 * deploy, and only one of them is fixed by pressing "Pull from feed".
 *
 * This pins the reading the screen depends on, including the case that started
 * it â€” a tenant whose automatic refresh has never run at all.
 */
const PASSWORD = 'password123';
const ORG = 'org_grh';
const STORE = 'store_grh';
const MANAGER = 'mgr@grh.local';
const SELLER = 'rep@grh.local';

describe('Gold rate refresh health (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const token: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string) => {
    const r = await request(server()).post('/auth/login').send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

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

    // A jewellery tenant â€” the only industry whose pack maintains metal rates.
    await prisma.organisation.create({
      data: { id: ORG, name: 'Gold Health', slug: 'grh', industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: STORE, name: 'Main', city: 'Surat', organisationId: ORG, timezone: 'Asia/Kolkata' },
    });
    for (const [email, name, role] of [
      [MANAGER, 'Manager', 'store_manager'],
      [SELLER, 'Seller', 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          email, name, role, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: ORG,
          userStores: { create: { storeId: STORE, isPrimary: true } },
        },
      });
    }
    token.manager = await login(MANAGER);
    token.seller = await login(SELLER);
  }, 120_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('reports a tenant whose refresh has NEVER run, rather than implying it is fine', async () => {
    const res = await request(server())
      .get('/integrations/gold-rate/health')
      .set(auth(token.manager))
      .expect(200);

    // Null, not a zero timestamp and not "just now" â€” the difference between
    // "nothing has pulled here" and "it pulled and found nothing".
    expect(res.body.lastRunAt).toBeNull();
    expect(res.body.ageHours).toBeNull();
    expect(res.body.overdue).toBe(true);
    // IBJA is the default source; no GOLD_RATE_API_URL is set in test.
    expect(res.body.source).toBe('ibja');
  });

  it('reports a recent successful run as healthy, and says it wrote new prices', async () => {
    await prisma.scheduledJobRun.create({
      data: {
        organisationId: ORG,
        job: GOLD_RATE_JOB,
        scope: ORG,
        runKey: 'test-recent',
        status: 'ok',
        startedAt: new Date(Date.now() - 30 * 60 * 1000), // half an hour ago
        endedAt: new Date(),
        detail: JSON.stringify({ updated: true, rates: { gold_22k: 13934 } }),
      },
    });

    const res = await request(server())
      .get('/integrations/gold-rate/health')
      .set(auth(token.manager))
      .expect(200);

    expect(res.body.lastRunAt).not.toBeNull();
    expect(res.body.overdue).toBe(false);
    expect(res.body.lastRunUpdated).toBe(true);
    expect(res.body.ageHours).toBeLessThan(1);
  });

  it('distinguishes "ran and found nothing newer" from "wrote a new price"', async () => {
    await prisma.scheduledJobRun.create({
      data: {
        organisationId: ORG,
        job: GOLD_RATE_JOB,
        scope: ORG,
        runKey: 'test-skipped',
        status: 'ok',
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
        endedAt: new Date(),
        // What the scheduler actually writes when the stored rate is still fresh.
        detail: JSON.stringify({ updated: false, dryRun: false, skipped: true }),
      },
    });

    const res = await request(server())
      .get('/integrations/gold-rate/health')
      .set(auth(token.manager))
      .expect(200);

    // Healthy, but honest that no new price was stored. A screen that said
    // "refreshed" here would imply today's rate when nothing changed.
    expect(res.body.overdue).toBe(false);
    expect(res.body.lastRunUpdated).toBe(false);
  });

  it('flags a refresh that has stopped running, even though rows exist', async () => {
    await prisma.scheduledJobRun.deleteMany({ where: { organisationId: ORG, job: GOLD_RATE_JOB } });
    await prisma.scheduledJobRun.create({
      data: {
        organisationId: ORG,
        job: GOLD_RATE_JOB,
        scope: ORG,
        runKey: 'test-stale',
        status: 'ok',
        startedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000), // six days ago
        endedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        detail: JSON.stringify({ updated: true }),
      },
    });

    const res = await request(server())
      .get('/integrations/gold-rate/health')
      .set(auth(token.manager))
      .expect(200);

    // This is the deployment symptom: the job ran once and then stopped. The
    // rate on screen looks like a number; only this says nothing is pulling.
    expect(res.body.overdue).toBe(true);
    expect(res.body.ageHours).toBeGreaterThan(24);
  });

  it('never reads another tenant\'s refresh history', async () => {
    // A run belonging to nobody this caller can see must not make their own
    // refresh look healthy.
    await prisma.scheduledJobRun.deleteMany({ where: { organisationId: ORG, job: GOLD_RATE_JOB } });

    const res = await request(server())
      .get('/integrations/gold-rate/health')
      .set(auth(token.manager))
      .expect(200);
    expect(res.body.lastRunAt).toBeNull();
  });

  it('is refused for a salesperson', async () => {
    const res = await request(server())
      .get('/integrations/gold-rate/health')
      .set(auth(token.seller));
    expect(res.status).toBe(403);
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.scheduledJobRun.deleteMany({ where: { organisationId: ORG } });
  await prisma.metalRate.deleteMany({ where: { organisationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}
