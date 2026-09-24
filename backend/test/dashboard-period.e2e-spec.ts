import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The dashboard's time window.
 *
 * The tiles only ever counted today. On a tenant whose history came from the
 * legacy ERP that read as an empty system: the twelve-month chart showed crores
 * and every tile above it showed zero, so the import looked like it had failed
 * when in fact nothing had been sold *that day*. These cases pin the windows so
 * a figure can never again be silently confined to today.
 */
const PASSWORD = 'password123';
const MANAGER = 'aarav.mehta@caratsense.in'; // store_manager, Surat only
const SURAT = 'surat-main';

describe('Dashboard period window (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  /** What each window read BEFORE the fixtures - the store is already seeded. */
  const before: Record<string, number> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const sales = (period?: string) =>
    request(app.getHttpServer())
      .get('/dashboard/kpis' + (period ? `?period=${period}` : ''))
      .set(auth())
      .set('X-Store-Id', SURAT);

  const valueOf = (body: { id: string; value: number }[], id: string) =>
    body.find((k) => k.id === id)?.value ?? 0;
  const labelOf = (body: { id: string; label: string }[], id: string) =>
    body.find((k) => k.id === id)?.label ?? '';

  /** A sale N days before today, at noon, so no timezone edge decides the test. */
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
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

    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: MANAGER, password: PASSWORD });
    expect(r.status).toBe(201);
    token = r.body.token;

    const organisationId = (
      await prisma.store.findUniqueOrThrow({
        where: { id: SURAT },
        select: { organisationId: true },
      })
    ).organisationId;

    for (const p of ['today', 'week', 'month', 'quarter']) {
      const res = await sales(p).expect(200);
      before[p] = valueOf(res.body, 'sales');
    }

    // One sale in each band, so every window has a figure only it can see.
    for (const [ref, age, amount] of [
      ['PERIOD-45D', 45, 500000],
      ['PERIOD-20D', 20, 200000],
      ['PERIOD-3D', 3, 30000],
    ] as const) {
      await prisma.sale.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId: ref } },
        update: { totalAmount: amount, docDate: daysAgo(age) },
        create: {
          organisationId,
          legacyId: ref,
          storeId: SURAT,
          docNo: ref,
          docDate: daysAgo(age),
          totalAmount: amount,
          docType: 'sale',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.sale.deleteMany({ where: { legacyId: { startsWith: 'PERIOD-' } } });
    await app?.close();
  });

  it('defaults to today, and today does not include a sale from three days ago', async () => {
    const res = await sales().expect(200);
    const today = valueOf(res.body, 'sales');
    const explicit = await sales('today').expect(200);
    expect(valueOf(explicit.body, 'sales')).toBe(today);
    // None of the three fixtures is today's, so today is untouched by them.
    expect(today).toBe(before.today);
    expect(labelOf(res.body, 'sales')).toBe('Sales Today');
  });

  it('each window reaches back exactly as far as it says', async () => {
    const week = valueOf((await sales('week').expect(200)).body, 'sales');
    const month = valueOf((await sales('month').expect(200)).body, 'sales');
    const quarter = valueOf((await sales('quarter').expect(200)).body, 'sales');

    // 7 days sees the 3-day sale only; 30 days also sees the 20-day one;
    // 90 days also sees the 45-day one. Measured as the change each window
    // shows, because the store was already trading before these fixtures.
    expect(week - before.week).toBe(30000);
    expect(month - before.month).toBe(230000);
    expect(quarter - before.quarter).toBe(730000);
    // Monotonic by construction — a wider window can never show less.
    expect(month).toBeGreaterThanOrEqual(week);
    expect(quarter).toBeGreaterThanOrEqual(month);
  });

  it('the label says which window the number is for', async () => {
    for (const [period, suffix] of [
      ['week', '7d'],
      ['month', '30d'],
      ['quarter', '90d'],
      ['year', '12m'],
    ] as const) {
      const body = (await sales(period).expect(200)).body;
      expect(labelOf(body, 'sales')).toBe(`Sales · ${suffix}`);
    }
  });

  it('an unknown period is today, not an error and not everything', async () => {
    const res = await sales('since-the-beginning-of-time').expect(200);
    const today = valueOf((await sales('today').expect(200)).body, 'sales');
    expect(valueOf(res.body, 'sales')).toBe(today);
    expect(labelOf(res.body, 'sales')).toBe('Sales Today');
  });

  it('the store comparison follows the window too', async () => {
    const today = await request(app.getHttpServer())
      .get('/dashboard/charts?period=today')
      .set(auth())
      .set('X-Store-Id', SURAT)
      .expect(200);
    const quarter = await request(app.getHttpServer())
      .get('/dashboard/charts?period=quarter')
      .set(auth())
      .set('X-Store-Id', SURAT)
      .expect(200);

    const revenueOf = (body: { storeComparison: { store: string; revenue: number }[] }) =>
      body.storeComparison.reduce((n, s) => n + s.revenue, 0);
    // Left on the calendar month, a shop with only older sales reads as zero.
    expect(revenueOf(quarter.body)).toBeGreaterThan(revenueOf(today.body));
  });
});
