import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { PERMISSIONS_KEY, ROLE_PERMISSIONS, type Permission } from '../src/auth/permissions';
import { IS_PUBLIC_KEY } from '../src/auth/public.decorator';
import { ROLE_LABELS, ROLE_RANK } from '../src/common/role.util';

/**
 * The storeperson: a branch's inventory job, and nothing else.
 *
 *  1. EVERY ROLE IS CLASSIFIED. A role in the enum with no rank, label or
 *     permission list fails here (and at compile time).
 *  2. CLOSED BY DEFAULT. The routes a storeperson can reach are pinned below. A
 *     new controller is refused to them until somebody adds a @Permit AND updates
 *     this list — two deliberate edits, not an accident.
 *  3. NOTHING ABOUT CUSTOMERS, MONEY OR THE TEAM, refused on the server whatever
 *     the menu shows.
 *  4. STRICTLY THEIR BRANCH.
 *  5. THE LADDER IS UNCHANGED FOR EVERYONE ELSE: a salesperson still cannot
 *     inward stock just because a storeperson can.
 */

const PASSWORD = 'password123';
const A = { org: 'org_sp_a', slug: 'sp-a', s1: 'store_sp_1', s2: 'store_sp_2' };

/** Every route a storeperson may open. Sorted. Change deliberately. */
const STOREPERSON_ROUTES = [
  'DELETE /notifications',
  'DELETE /notifications/:id',
  'DELETE /products/:id/images/:imageId',
  'GET /auth/me',
  'GET /config/bootstrap',
  'GET /config/capabilities',
  'GET /config/taxonomy',
  'GET /hrms/attendance',
  'GET /hrms/attendance/:id/photo/:which',
  'GET /hrms/attendance/me',
  'GET /hrms/geofence',
  'GET /hrms/holidays',
  'GET /hrms/leave',
  'GET /hrms/leave/balances',
  'GET /hrms/payroll/payslips',
  'GET /hrms/payroll/payslips/:id',
  'GET /hrms/regularize',
  'GET /hrms/shifts',
  'GET /notifications',
  'GET /notifications/summary',
  'GET /onboarding/tour',
  'GET /products',
  'GET /products/:id',
  'GET /products/:id/images',
  'GET /products/:id/pieces',
  'GET /stock',
  'GET /stock/dead',
  'GET /stock/dead/policy',
  'GET /stock/summary',
  'GET /stock/vin/:vin',
  'GET /stores',
  'PATCH /hrms/leave/:id/cancel',
  'PATCH /notifications/:id/read',
  'POST /auth/change-password',
  'POST /hrms/attendance/check-in',
  'POST /hrms/attendance/check-out',
  'POST /hrms/leave',
  'POST /hrms/regularize',
  'POST /import-images/preview',
  'POST /import-images/run',
  'POST /notifications/read-all',
  'POST /onboarding/tour/done',
  'POST /onboarding/tour/reset',
  'POST /onboarding/tour/viewed',
  'POST /products/:id/image',
  'POST /products/:id/images',
  'POST /products/:id/images/:imageId/primary',
  'POST /products/image-search',
  'POST /products/jewelry/similarity-feedback',
  'POST /products/jewelry/similarity-search',
  'POST /stock',
];

/** Families that must never appear above, whatever someone adds later. */
const NEVER_FOR_STOREPERSON = [
  '/crm', '/leads', '/parties', '/checkins', '/quotes', '/discounts', '/payments', '/sales',
  '/finance', '/users', '/integrations', '/reporting', '/management', '/dashboard', '/loyalty',
  '/omnichannel', '/conversations', '/feedback', '/campaigns', '/marketing', '/returns',
  '/hrms/payroll/runs', '/hrms/payroll/compensation', '/hrms/attendance/team', '/search',
  '/catalogue-exports', '/stock/dead/export',
];

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const org = A.org;
  await prisma.auditLog.deleteMany({ where: { organisationId: org } });
  await prisma.stockItem.deleteMany({ where: { storeId: { in: [A.s1, A.s2] } } });
  await prisma.attendanceRecord.deleteMany({ where: { storeId: { in: [A.s1, A.s2] } } });
  await prisma.payslip.deleteMany({ where: { organisationId: org } });
  await prisma.lead.deleteMany({ where: { organisationId: org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.user.deleteMany({ where: { organisationId: org } });
  await prisma.store.deleteMany({ where: { organisationId: org } });
  await prisma.organisation.deleteMany({ where: { id: org } });
}

describe('Storeperson role (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'SP', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.createMany({
      data: [
        { id: A.s1, name: 'One', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.s2, name: 'Two', city: 'Pune', organisationId: A.org, timezone: 'Asia/Kolkata' },
      ],
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, role, store] of [
      ['u_sp_store', 'storeperson', A.s1],
      ['u_sp_store2', 'storeperson', A.s2],
      ['u_sp_sales', 'salesperson', A.s1],
      ['u_sp_mgr', 'store_manager', A.s1],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email: `${id}@sp-a.local`, name: id, role: role as Role, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org, userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }
    await prisma.stockItem.createMany({
      data: [
        { organisationId: A.org, storeId: A.s1, sku: 'SP-1', metal: 'gold_22k', status: 'in_stock', vin: 'VIN-SP-1', cost: 90000, tagPrice: 120000 },
        { organisationId: A.org, storeId: A.s2, sku: 'SP-2', metal: 'gold_22k', status: 'in_stock', vin: 'VIN-SP-2', cost: 50000, tagPrice: 70000 },
      ] as never,
    });
    for (const who of ['u_sp_store', 'u_sp_store2', 'u_sp_sales', 'u_sp_mgr']) {
      t[who] = (
        await request(server()).post('/auth/login').send({ email: `${who}@sp-a.local`, password: PASSWORD }).expect(201)
      ).body.token;
    }
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('classifies every role in the enum', () => {
    for (const role of Object.values(Role)) {
      expect(ROLE_RANK[role]).toBeDefined();
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it('opens exactly the pinned routes to a storeperson, and none of the forbidden families', () => {
    const modules = app.get(ModulesContainer);
    const held = new Set<Permission>(ROLE_PERMISSIONS.storeperson);
    const open: string[] = [];
    for (const mod of modules.values()) {
      for (const wrapper of mod.controllers.values()) {
        const ctor = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
        if (!ctor?.prototype) continue;
        const prefix = String(Reflect.getMetadata(PATH_METADATA, ctor) ?? '');
        const classPermits = (Reflect.getMetadata(PERMISSIONS_KEY, ctor) ?? []) as Permission[];
        const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctor) === true;
        for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
          const handler = ctor.prototype[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const path = Reflect.getMetadata(PATH_METADATA, handler);
          if (path === undefined) continue;
          if (classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true) continue;
          const permits = (Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? classPermits) as Permission[];
          if (!permits.some((p) => held.has(p))) continue;
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
          const full = `/${[prefix, String(path)].filter((s) => s && s !== '/').join('/')}`.replace(/\/+/g, '/');
          open.push(`${method} ${full}`);
        }
      }
    }
    expect(open.sort()).toEqual(STOREPERSON_ROUTES);
    for (const route of open) {
      const path = route.split(' ')[1];
      expect(NEVER_FOR_STOREPERSON.filter((f) => path === f || path.startsWith(`${f}/`))).toEqual([]);
    }
  });

  it('refuses a storeperson every customer, money, team and settings surface', async () => {
    const denied = [
      '/leads', '/crm/conversations', '/crm/customers/x', '/parties', '/checkins', '/quotes',
      '/discounts', '/payments', '/sales', '/users', '/users/pending', '/integrations/status',
      '/management/kpis', '/reporting/dsr', '/dashboard/kpis', '/search?q=a', '/loyalty/members',
      '/omnichannel/outbox', '/stock/dead/export.xlsx', '/hrms/attendance/team', '/hrms/payroll/runs',
      '/hrms/payroll/compensation/u_sp_sales', '/hrms/leaderboard', '/hrms/commission', '/tickets',
      '/returns', '/feedback/summary', '/crm/exports/leads.xlsx', '/timelines/orders', '/requests',
    ];
    for (const path of denied) {
      const res = await request(server()).get(path).set(as('u_sp_store'));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    await request(server()).post('/leads').set(as('u_sp_store')).send({}).expect(403);
    await request(server()).post('/checkins').set(as('u_sp_store')).send({}).expect(403);
    await request(server()).post('/stock/bulk-adjust').set(as('u_sp_store')).send({}).expect(403);
  });

  it('lets a storeperson do the inventory job at their own branch', async () => {
    await request(server()).get('/auth/me').set(as('u_sp_store')).expect(200);
    await request(server()).get('/config/bootstrap').set(as('u_sp_store')).expect(200);
    await request(server()).get('/products').set(as('u_sp_store')).expect(200);
    await request(server()).get('/stock/dead').set(as('u_sp_store')).expect(200);

    const stock = await request(server()).get('/stock').set(as('u_sp_store')).expect(200);
    const skus = (stock.body.items ?? stock.body).map((s: { sku: string }) => s.sku);
    expect(skus).toEqual(['SP-1']);
    // No cost, margin or making charge on the wire.
    expect(JSON.stringify(stock.body)).not.toMatch(/"cost"|costPrice|margin|makingAmount/);

    await request(server()).get('/stock/vin/VIN-SP-1').set(as('u_sp_store')).expect(200);

    await request(server())
      .post('/stock')
      .set(as('u_sp_store'))
      .send({ storeId: A.s1, sku: 'SP-IN-1', metal: 'gold_18k' })
      .expect(201);
    // Strictly their branch.
    await request(server())
      .post('/stock')
      .set(as('u_sp_store'))
      .send({ storeId: A.s2, sku: 'SP-IN-2', metal: 'gold_18k' })
      .expect(403);
  });

  it('sees only their own attendance and payslips', async () => {
    await prisma.attendanceRecord.createMany({
      data: [
        { organisationId: A.org, storeId: A.s1, staffId: 'u_sp_store', staffName: 'me', date: new Date('2026-09-01'), status: 'present' },
        { organisationId: A.org, storeId: A.s1, staffId: 'u_sp_sales', staffName: 'colleague', date: new Date('2026-09-01'), status: 'present' },
      ] as never,
    });
    const att = await request(server()).get('/hrms/attendance').set(as('u_sp_store')).expect(200);
    const rows = att.body.items ?? att.body;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { staffId?: string; staff?: { id: string } }) => (r.staffId ?? r.staff?.id) === 'u_sp_store')).toBe(true);

    await request(server()).get('/hrms/payroll/payslips?userId=u_sp_sales').set(as('u_sp_store')).expect(403);
    await request(server()).get('/hrms/payroll/payslips').set(as('u_sp_store')).expect(200);
  });

  it('leaves the ladder alone for everyone else', async () => {
    // A permission a storeperson holds does not lower the bar for a salesperson.
    await request(server())
      .post('/stock')
      .set(as('u_sp_sales'))
      .send({ storeId: A.s1, sku: 'SP-IN-3', metal: 'gold_18k' })
      .expect(403);
    await request(server()).get('/leads').set(as('u_sp_sales')).expect(200);
    await request(server())
      .post('/stock')
      .set(as('u_sp_mgr'))
      .send({ storeId: A.s1, sku: 'SP-IN-4', metal: 'gold_18k' })
      .expect(201);
  });

  it('a store manager may provision a storeperson; a salesperson may not', async () => {
    const body = { name: 'New Stock Hand', phone: '9812388001', email: 'stockhand@sp-a.local', role: 'storeperson', storeId: A.s1 };
    await request(server()).post('/users').set(as('u_sp_sales')).send(body).expect(403);
    const made = await request(server()).post('/users').set(as('u_sp_mgr')).send(body);
    expect([200, 201]).toContain(made.status);
    const row = await prisma.user.findFirst({ where: { organisationId: A.org, name: 'New Stock Hand' } });
    expect(row?.role).toBe('storeperson');
    // And a storeperson cannot provision anyone.
    await request(server()).post('/users').set(as('u_sp_store')).send({ ...body, email: 'x2@sp-a.local', phone: '9812388002' }).expect(403);
  });
});
