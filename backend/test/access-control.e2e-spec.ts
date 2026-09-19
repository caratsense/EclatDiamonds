import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Who may open which screen (auth/access.ts), enforced on the API.
 *
 *  1. Four roles. Marketing gets CRM and marketing at store level and its own
 *     attendance; nothing about stock, quotes or money.
 *  2. Head office changes one person's screens: a screen switched off is refused
 *     on the server, one switched on really works (store level, own store).
 *  3. Head-office-only screens are never given away, head office itself is
 *     never limited, and nobody else may edit access.
 *  4. Area manager and storeperson are retired: nobody can be given them.
 *  5. A salesperson files the day's DSR but cannot overwrite a filed one.
 *  6. A person changes their own contact details, nothing else.
 */

const PASSWORD = 'password123';
const A = { org: 'org_acc', slug: 'acc', store: 'store_acc' };
const DAY = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

async function teardown(prisma: PrismaService) {
  await prisma.dailyReport.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.employeeProfile.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Screen access by role and by person (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const get = (who: string, path: string) => request(server()).get(path).set(as(who));

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'Acc', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org } });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [who, role] of [
      ['ho', 'head_office'],
      ['mgr', 'store_manager'],
      ['rep', 'salesperson'],
      ['mkt', 'marketing'],
    ] as const) {
      await prisma.user.create({
        data: {
          id: `u_acc_${who}`, email: `${who}@acc.local`, name: `acc ${who}`, role, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
      t[who] = (await request(server()).post('/auth/login').send({ email: `${who}@acc.local`, password: PASSWORD }).expect(201)).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('the session says what each role may open', async () => {
    const rep = (await get('rep', '/auth/me').expect(200)).body.access;
    expect(rep).toMatchObject({ hrms: 'own', reporting: 'own', catalogue: 'own', crm: 'own' });
    expect(rep.inventory).toBeUndefined();
    const mkt = (await get('mkt', '/auth/me').expect(200)).body.access;
    expect(mkt).toMatchObject({ crm: 'store', campaigns: 'store', hrms: 'own' });
    expect(mkt.quotation).toBeUndefined();
    expect(mkt.inventory).toBeUndefined();
    const mgr = (await get('mgr', '/auth/me').expect(200)).body.access;
    expect(mgr).toMatchObject({ inventory: 'store', hrms: 'store', approvals: 'store' });
    expect(mgr.finance).toBeUndefined();
    expect(mgr.campaigns).toBeUndefined();
  });

  it('marketing works CRM at store level and is refused stock and quotes', async () => {
    await get('mkt', '/leads').expect(200);
    await get('mkt', '/stock').expect(403);
    await get('mkt', '/quotes').expect(403);
  });

  it('a screen head office switches on really works; one switched off is refused', async () => {
    await get('rep', '/stock').expect(403);
    await request(server())
      .put('/users/u_acc_rep/access')
      .set(as('ho'))
      .send({ overrides: { inventory: 'store', hrms: 'none', crm: 'own' } })
      .expect(200)
      .expect((r) => {
        // The crm entry equals the role's default, so it is not stored.
        expect(r.body.overrides).toEqual({ inventory: 'store', hrms: 'none' });
        expect(r.body.effective.inventory).toBe('store');
        expect(r.body.effective.hrms).toBeUndefined();
      });
    await get('rep', '/stock').expect(200);
    await get('rep', '/hrms/shifts').expect(403);
    expect((await get('rep', '/auth/me').expect(200)).body.access.inventory).toBe('store');
    expect(await prisma.auditLog.count({ where: { organisationId: A.org, action: 'user.access_update' } })).toBe(1);

    await request(server()).put('/users/u_acc_rep/access').set(as('ho')).send({ overrides: {} }).expect(200);
    await get('rep', '/stock').expect(403);
    await get('rep', '/hrms/shifts').expect(200);
  });

  it('head-office screens are never given away, head office is never limited, only head office edits', async () => {
    await request(server()).put('/users/u_acc_rep/access').set(as('ho')).send({ overrides: { 'settings/access': 'store' } }).expect(400);
    await request(server()).put('/users/u_acc_ho/access').set(as('ho')).send({ overrides: { crm: 'none' } }).expect(400);
    await request(server()).put('/users/u_acc_rep/access').set(as('mgr')).send({ overrides: { inventory: 'store' } }).expect(403);
    await request(server()).get('/users/u_acc_rep/access').set(as('mgr')).expect(403);
  });

  it('nobody can be given the retired roles', async () => {
    for (const role of ['area_manager', 'storeperson']) {
      await request(server())
        .post('/users')
        .set(as('ho'))
        .send({ name: 'Retired Role', phone: '9876500011', email: 'r@acc.local', storeId: A.store, role })
        .expect(400);
      await request(server()).patch('/users/u_acc_rep/role').set(as('ho')).send({ role }).expect(400);
    }
    await request(server())
      .post('/users')
      .set(as('ho'))
      .send({ name: 'Mira Shah', phone: '9876500012', email: 'mira@acc.local', storeId: A.store, role: 'marketing' })
      .expect(201);
  });

  it('a salesperson files the DSR but cannot overwrite a filed one; a manager can', async () => {
    const body = { storeId: A.store, reportDate: DAY, walkIns: 10, seriousEnquiries: 3 };
    await request(server()).post('/reporting/daily').set(as('rep')).send(body).expect(201);
    await request(server()).post('/reporting/daily').set(as('rep')).send({ ...body, walkIns: 99 }).expect(403);
    await request(server()).post('/reporting/daily').set(as('mgr')).send({ ...body, walkIns: 12 }).expect(201);
    const list = await get('rep', `/reporting/daily?date=${DAY}`).expect(200);
    expect(list.body[0]).toMatchObject({ walkIns: 12, source: 'web' });
  });

  it('a person changes their own contact details and nothing else', async () => {
    const res = await request(server()).patch('/auth/me').set(as('rep')).send({ phone: '98765 43210', contactEmail: 'Rep@Example.com' }).expect(200);
    expect(res.body.user).toMatchObject({ phone: '9876543210', contactEmail: 'rep@example.com' });
    await request(server()).patch('/auth/me').set(as('rep')).send({ phone: '12' }).expect(400);
    await request(server()).patch('/auth/me').set(as('rep')).send({ name: 'Someone Else' }).expect(400);
    await request(server()).patch('/auth/me').set(as('rep')).send({ role: 'head_office' }).expect(400);
  });
});
