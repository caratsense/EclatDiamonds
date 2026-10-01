import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { inspect } from 'node:util';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * A manager hands out a working login in one form.
 *
 * Add staff minted a Login ID and a random password nobody knew, so the new
 * person could not sign in until the manager also opened Reset password. Add
 * staff now takes the password as well.
 *
 *  1. Added with a password, the person signs in with their mobile number, and
 *     with the Login ID.
 *  2. The password goes nowhere else: not into the answer, not into the audit
 *     row, not into a log line or an alert.
 *  3. Added without one, everything is as before.
 *  4. A password shorter than a reset would accept is refused.
 *  5. A salesperson cannot add anyone. A store manager cannot add a fellow
 *     manager, or anyone at a store that is not theirs.
 */

const PASSWORD = 'password123';
// Eight characters: the shortest a reset accepts, so the two rules stay one.
const FIRST_PASSWORD = 'day1pass';
const ORG = 'org_asp';
const STORE = 'store_asp';
// A second branch of the same shop, which the manager does not run, and a
// shop that is somebody else's altogether.
const OTHER_STORE = 'store_asp_annexe';
const ELSEWHERE = 'org_asp_elsewhere';
const ELSEWHERE_STORE = 'store_asp_elsewhere';

async function teardown(prisma: PrismaService) {
  const organisationId = { in: [ORG, ELSEWHERE] };
  await prisma.auditLog.deleteMany({ where: { organisationId } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId } } });
  await prisma.user.deleteMany({ where: { organisationId } });
  await prisma.store.deleteMany({ where: { organisationId } });
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
}

describe('Add staff with a password (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const login = (email: string, password: string) =>
    request(server()).post('/auth/login').send({ email, password });
  const add = (who: string, body: Record<string, unknown>) =>
    request(server())
      .post('/users')
      .set({ Authorization: `Bearer ${t[who]}` })
      .send({ storeId: STORE, ...body });
  /** What POST /users answers with: these fields and no others. */
  const view = (name: string, phone: string) => ({
    id: expect.any(String),
    name,
    email: expect.stringContaining('.counter@'),
    phone,
    role: 'salesperson',
    stores: [{ id: STORE, name: 'Counter' }],
    isActive: true,
  });
  const creationAudit = (userId: string) =>
    prisma.auditLog.findMany({ where: { organisationId: ORG, action: 'user.create', entityId: userId } });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: ORG, name: 'ASP', slug: 'asp', industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: STORE, name: 'Counter', city: 'Mumbai', organisationId: ORG } });
    await prisma.store.create({ data: { id: OTHER_STORE, name: 'Annexe', city: 'Mumbai', organisationId: ORG } });
    await prisma.organisation.create({
      data: { id: ELSEWHERE, name: 'ASP Elsewhere', slug: 'asp-elsewhere', industryPackCode: 'jewellery' },
    });
    await prisma.store.create({ data: { id: ELSEWHERE_STORE, name: 'Elsewhere', city: 'Pune', organisationId: ELSEWHERE } });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [who, role] of [['mgr', 'store_manager'], ['rep', 'salesperson']] as const) {
      await prisma.user.create({
        data: {
          id: `u_asp_${who}`, email: `${who}@asp.local`, name: `asp ${who}`, role, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: ORG,
          userStores: { create: { storeId: STORE, isPrimary: true } },
        },
      });
      t[who] = (await login(`${who}@asp.local`, PASSWORD).expect(201)).body.token;
    }
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('added with a password, the person signs in with their mobile number, and with the Login ID', async () => {
    const added = await add('mgr', {
      name: 'Nisha Rao', phone: '9744000001', email: 'nisha@home.example', password: FIRST_PASSWORD,
    }).expect(201);

    const byMobile = await login('9744000001', FIRST_PASSWORD).expect(201);
    expect(byMobile.body.user.id).toBe(added.body.id);
    const byLoginId = await login(added.body.email, FIRST_PASSWORD).expect(201);
    expect(byLoginId.body.user.id).toBe(added.body.id);
  });

  it('the password is in neither the answer nor the audit row', async () => {
    const added = await add('mgr', {
      name: 'Meera Iyer', phone: '9744000002', email: 'meera@home.example', password: FIRST_PASSWORD,
    }).expect(201);
    expect(added.body).toEqual(view('Meera Iyer', '9744000002'));

    const row = await prisma.user.findUniqueOrThrow({ where: { id: added.body.id } });
    // Stored the way a reset stores it: bcrypt, cost 10.
    expect(row.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(FIRST_PASSWORD, row.passwordHash!)).toBe(true);

    const audit = await creationAudit(added.body.id);
    expect(audit.map((a) => a.metadata)).toEqual([{ role: 'salesperson', storeId: STORE }]);
    for (const secret of [FIRST_PASSWORD, row.passwordHash!]) {
      expect(JSON.stringify(added.body)).not.toContain(secret);
      expect(JSON.stringify(audit)).not.toContain(secret);
    }
  });

  it('the password is in no log line and no alert, whether the add works, is refused or fails', async () => {
    const { StoreScopeService } = await import('../src/common/store-scope.service');
    // Everything the server writes: each log line at every level (read off the
    // logger itself, because a test app prints errors only), console.*, raw
    // stdout and stderr, and what a failed request sends to the alert webhook.
    const written: string[] = [];
    const keep = (...parts: unknown[]) => {
      written.push(parts.map((p) => (typeof p === 'string' ? p : inspect(p, { depth: 4 }))).join(' '));
    };
    const stream = (chunk: unknown) => {
      keep(String(chunk));
      return true;
    };
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(keep);
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, level).mockImplementation(keep);
    }
    jest.spyOn(process.stdout, 'write').mockImplementation(stream);
    jest.spyOn(process.stderr, 'write').mockImplementation(stream);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      keep(init?.body);
      return new Response();
    });
    const webhook = process.env.ALERT_WEBHOOK_URL;
    process.env.ALERT_WEBHOOK_URL = 'http://alerts.invalid/hook';
    try {
      const person = { name: 'Leela Nair', email: 'leela@home.example', password: FIRST_PASSWORD };
      await add('mgr', { ...person, phone: '9744000006' }).expect(201);
      await add('mgr', { ...person, phone: '12345' }).expect(400);
      // Something gives way half way through an add.
      jest.spyOn(app.get(StoreScopeService), 'assertStoreAllowed').mockImplementationOnce(() => {
        throw new Error('the database went away');
      });
      await add('mgr', { ...person, phone: '9744000007' }).expect(500);
    } finally {
      jest.restoreAllMocks();
      if (webhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
      else process.env.ALERT_WEBHOOK_URL = webhook;
    }

    const text = written.join('\n');
    // It was all read: the refused request, the failed one, and its alert.
    expect(text).toContain('POST /users -> 400');
    expect(text).toContain('POST /users -> 500');
    expect(text).toContain('Eclat backend 500');
    expect(text).not.toContain(FIRST_PASSWORD);
    // Nor a hash: of this password, or of any other.
    expect(text).not.toMatch(/\$2[aby]\$10\$/);
  });

  it('added without a password, everything is as before', async () => {
    const added = await add('mgr', { name: 'Kiran Shah', phone: '9744000003', email: 'kiran@home.example' }).expect(201);
    expect(added.body).toEqual(view('Kiran Shah', '9744000003'));

    // Still a real hash of something nobody typed, never an empty password.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: added.body.id } });
    expect(row.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare('', row.passwordHash!)).toBe(false);
    expect((await creationAudit(added.body.id)).map((a) => a.metadata)).toEqual([
      { role: 'salesperson', storeId: STORE },
    ]);
  });

  it('refuses a password shorter than a reset would accept, and adds nobody', async () => {
    for (const password of ['seven77', '']) {
      const res = await add('mgr', {
        name: 'Tara Jain', phone: '9744000004', email: 'tara@home.example', password,
      }).expect(400);
      expect(res.body.message).toEqual(['password must be longer than or equal to 8 characters']);
    }
    expect(await prisma.user.count({ where: { organisationId: ORG, name: 'Tara Jain' } })).toBe(0);

    // A reset draws the line in the same place.
    const reset = (newPassword: string) =>
      request(server())
        .post('/auth/reset-password')
        .set({ Authorization: `Bearer ${t.mgr}` })
        .send({ userId: 'u_asp_rep', newPassword });
    await reset('seven77').expect(400);
    await reset(FIRST_PASSWORD).expect(201);
  });

  it('a salesperson cannot add anyone', async () => {
    await add('rep', {
      name: 'Omar Khan', phone: '9744000005', email: 'omar@home.example', password: FIRST_PASSWORD,
    }).expect(403);
    expect(await prisma.user.count({ where: { organisationId: ORG, name: 'Omar Khan' } })).toBe(0);
  });

  it('a store manager cannot add a fellow manager, or anyone at a store that is not theirs', async () => {
    // These checks used to be followed by a second gate: the account could not
    // sign in until Reset password, which checks rank and store again. With a
    // password given here they decide alone.
    const refused = [{ role: 'store_manager' }, { storeId: OTHER_STORE }, { storeId: ELSEWHERE_STORE }];
    for (const [i, change] of refused.entries()) {
      await add('mgr', {
        name: 'Zoya Mirza', phone: `974400002${i}`, email: 'zoya@home.example', password: FIRST_PASSWORD, ...change,
      }).expect(403);
    }
    // In no organisation at all.
    expect(await prisma.user.count({ where: { name: 'Zoya Mirza' } })).toBe(0);
  });
});
