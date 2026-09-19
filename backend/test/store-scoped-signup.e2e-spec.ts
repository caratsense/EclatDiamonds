import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { AuthUser } from '../src/common/auth-user';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { PLATFORM_HANDLE_DOMAIN, loginIdTemplateError, renderLoginId } from '../src/users/users.util';

/**
 * Store-scoped self-signup: who may ask for what, who may grant it, and the
 * Login ID they are given.
 *
 *  - A pending request is powerless whatever door it tries (password, Google, a forged
 *    session, OTP, a manager's "activate").
 *  - A store manager decides front-line requests for their own stores only;
 *    manager requests are head office's, and only when the tenant allows them.
 *  - Approval is one conditional transaction: replay, a revoked approver and a
 *    closed store all change nothing.
 *  - Login IDs are assigned by the unique index, previewed from the template
 *    alone, and never rewritten for people who already have one.
 */
const PASSWORD = 'password123';
const T = {
  org: 'org_sss',
  slug: 'sss-jewels',
  a: 'store_sss_a',
  b: 'store_sss_b',
  c: 'store_sss_c',
  ho: 'ho@sss.local',
  mgrA: 'mgr.a@sss.local',
  mgrB: 'mgr.b@sss.local',
};
const OTHER = { org: 'org_sss_other', slug: 'sss-other', store: 'store_sss_other' };
const ECLAT_HO = 'head.office@caratsense.in';
const domain = `${T.slug}.${PLATFORM_HANDLE_DOMAIN}`;

async function teardown(prisma: PrismaService) {
  const orgs = [T.org, OTHER.org];
  await prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
  // What this suite added to the seeded Eclat tenant, and nothing else of theirs.
  const probes = await prisma.user.findMany({
    where: { organisationId: 'org_eclat', OR: [{ email: { startsWith: 'sssprobe' } }, { email: 'legacy.sss@eclatdiamonds.in' }] },
    select: { id: true },
  });
  const ids = probes.map((p) => p.id);
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

describe('Store-scoped self-signup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const clearThrottle = () =>
    (app.get(getStorageToken()) as ThrottlerStorageService).storage.clear();

  const login = (email: string, password = PASSWORD) =>
    request(server()).post('/auth/login').send({ email, password });

  let seq = 0;
  /** A valid signup body for a unique test person; override anything. */
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'Kavya Rao',
    password: 'applicant-pass-1',
    phone: `98200${String(10000 + seq++).slice(-5)}`,
    requestedRole: 'salesperson',
    requestedStoreId: T.a,
    organisationCode: T.slug,
    ...over,
  });
  const signup = (over: Record<string, unknown> = {}) => {
    clearThrottle();
    return request(server()).post('/auth/signup').send(body(over));
  };
  const pendingId = async (loginId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { email: loginId } })).id;
  const approve = (token: string, id: string, dto: object = {}) =>
    request(server()).post(`/users/${id}/approve`).set(as(token)).send(dto);

  beforeAll(async () => {
    // Deterministic outside world: email is never really sent from this suite,
    // and Google sign-in is "configured" so its account checks can be reached.
    process.env.SMTP_HOST = '';
    process.env.GOOGLE_CLIENT_ID = 'store-scoped-signup-test';
    process.env.GOOGLE_ALLOWED_DOMAINS = '';
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
    await prisma.organisation.create({ data: { id: T.org, name: 'SSS Jewels', slug: T.slug } });
    await prisma.organisation.create({ data: { id: OTHER.org, name: 'SSS Other', slug: OTHER.slug } });
    await prisma.store.createMany({
      data: [
        { id: T.a, name: 'Andheri', city: 'Mumbai', organisationId: T.org },
        { id: T.b, name: 'Bandra', city: 'Mumbai', organisationId: T.org },
        { id: T.c, name: 'Colaba', city: 'Mumbai', organisationId: T.org },
        { id: OTHER.store, name: 'Elsewhere', city: 'Pune', organisationId: OTHER.org },
      ],
    });
    const staff = (email: string, role: 'head_office' | 'store_manager', storeId: string) =>
      prisma.user.create({
        data: {
          email, name: email.split('@')[0], role, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: T.org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
    await staff(T.ho, 'head_office', T.a);
    await staff(T.mgrA, 'store_manager', T.a);
    await staff(T.mgrB, 'store_manager', T.b);
    for (const [key, email] of [['ho', T.ho], ['mgrA', T.mgrA], ['mgrB', T.mgrB]] as const) {
      clearThrottle();
      tokens[key] = (await login(email).expect(201)).body.token;
    }
  });

  afterAll(async () => {
    if (prisma) {
      // Leave the seeded tenant as it was found, even if the Eclat case failed midway.
      if (eclatSettingsBefore) {
        await prisma.organisation.update({
          where: { id: 'org_eclat' },
          data: { settings: (eclatSettingsBefore.value ?? Prisma.DbNull) as Prisma.InputJsonValue },
        });
      }
      await teardown(prisma);
    }
    await app?.close();
  });
  let eclatSettingsBefore: { value: unknown } | null = null;

  /* ─────────────────────────── powerless while pending ─────────────────────────── */

  describe('a pending request is powerless', () => {
    let id: string;
    let loginId: string;
    const phone = '9820099001';

    beforeAll(async () => {
      const res = await signup({ name: 'Nisha Gupta', phone, requestedRole: 'storeperson' }).expect(201);
      loginId = res.body.loginId;
      id = await pendingId(loginId);
    });

    it('is stored inactive, pending, salesperson-placeholder, with no store link', async () => {
      const row = await prisma.user.findUniqueOrThrow({ where: { id }, include: { userStores: true } });
      expect(row).toMatchObject({
        isActive: false,
        approvalStatus: 'pending',
        role: 'salesperson',
        requestedRole: 'storeperson',
        requestedStoreId: T.a,
        organisationId: T.org,
      });
      expect(row.userStores).toEqual([]);
    });

    it('cannot sign in with its password', async () => {
      clearThrottle();
      await login(loginId, 'applicant-pass-1').expect(401);
    });

    it('cannot use a session token, even a validly signed one', async () => {
      const token = await app.get(JwtService).signAsync({ sub: id, email: loginId, name: 'x', role: 'salesperson' });
      await request(server()).get('/auth/me').set(as(token)).expect(401);
    });

    it('cannot sign in with Google, while an approved account can', async () => {
      const auth = app.get(AuthService);
      const asGoogle = (email: string, sub: string) =>
        jest.spyOn(auth as unknown as { verifyGoogleToken: () => Promise<object> }, 'verifyGoogleToken')
          .mockResolvedValueOnce({ iss: 'accounts.google.com', email_verified: true, email, sub });
      const google = () => request(server()).post('/auth/google').send({ credential: 'google-id-token-stub' });

      asGoogle(loginId, 'g-sub-pending');
      clearThrottle();
      await google().expect(401);
      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).googleSub).toBeNull();

      asGoogle(T.mgrB, 'g-sub-approved'); // positive control: the same path admits a real account
      clearThrottle();
      await google().expect(201);
    });

    it('is never sent an OTP', async () => {
      clearThrottle();
      const res = await request(server()).post('/auth/otp/request').send({ phone }).expect(201);
      expect(res.body.sent).toBe(true); // same answer as an unknown number
      expect(await prisma.loginOtp.count({ where: { phone } })).toBe(0);
    });

    it('cannot be switched on, re-roled or store-linked around the approval step', async () => {
      await request(server()).patch(`/users/${id}/activate`).set(as(tokens.ho)).send({}).expect(409);
      await request(server()).patch(`/users/${id}/role`).set(as(tokens.ho)).send({ role: 'store_manager' }).expect(409);
      await request(server()).patch(`/users/${id}/store`).set(as(tokens.ho)).send({ storeId: T.a }).expect(409);
      const row = await prisma.user.findUniqueOrThrow({ where: { id }, include: { userStores: true } });
      expect(row.isActive).toBe(false);
      expect(row.userStores).toEqual([]);
    });
  });

  describe('the applicant cannot grant themselves anything', () => {
    it.each([
      ['role', { role: 'head_office' }],
      ['approvalStatus', { approvalStatus: 'approved' }],
      ['isActive', { isActive: true }],
      ['organisationId', { organisationId: OTHER.org }],
    ])('refuses a mass-assigned %s', async (_field, extra) => {
      const before = await prisma.user.count({ where: { organisationId: T.org } });
      await signup(extra).expect(400);
      expect(await prisma.user.count({ where: { organisationId: T.org } })).toBe(before);
    });

    it.each(['head_office', 'area_manager'])('refuses a requested role of %s', async (role) => {
      await signup({ requestedRole: role }).expect(400);
    });

    it('holds the requested role as metadata only', async () => {
      const res = await signup({ name: 'Ira Shah', requestedRole: 'storeperson' }).expect(201);
      clearThrottle();
      await login(res.body.loginId, 'applicant-pass-1').expect(401);
      const row = await prisma.user.findUniqueOrThrow({ where: { email: res.body.loginId } });
      expect(row.role).toBe('salesperson');
    });
  });

  /* ───────────────────────────── cross-tenant stores ───────────────────────────── */

  describe('another tenant’s store', () => {
    it('is refused at signup exactly like a store that does not exist', async () => {
      const foreign = await signup({ requestedStoreId: OTHER.store }).expect(400);
      const missing = await signup({ requestedStoreId: 'store_does_not_exist' }).expect(400);
      expect(foreign.body.message).toEqual(missing.body.message);
      expect(JSON.stringify(foreign.body)).not.toContain('Elsewhere');
      expect(await prisma.user.count({ where: { organisationId: OTHER.org } })).toBe(0);
    });

    it('is refused as an approval override without revealing it exists', async () => {
      const res = await signup({ name: 'Tara Nair' }).expect(201);
      const id = await pendingId(res.body.loginId);
      const foreign = await approve(tokens.ho, id, { storeId: OTHER.store }).expect(400);
      const missing = await approve(tokens.ho, id, { storeId: 'store_does_not_exist' }).expect(400);
      expect(foreign.body.message).toEqual(missing.body.message);
      // A scoped manager gets the same 403 for a foreign store as for a sibling one.
      const mForeign = await approve(tokens.mgrA, id, { storeId: OTHER.store }).expect(403);
      const mSibling = await approve(tokens.mgrA, id, { storeId: T.b }).expect(403);
      expect(mForeign.body.message).toEqual(mSibling.body.message);
      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).approvalStatus).toBe('pending');
    });
  });

  /* ─────────────────────────────── store managers ──────────────────────────────── */

  describe('a store manager decides front-line requests for their own store only', () => {
    let aSales: string;
    let aStore: string;
    let bSales: string;

    beforeAll(async () => {
      aSales = await pendingId((await signup({ name: 'Anil Joshi' }).expect(201)).body.loginId);
      aStore = await pendingId(
        (await signup({ name: 'Asha Menon', requestedRole: 'storeperson' }).expect(201)).body.loginId,
      );
      bSales = await pendingId(
        (await signup({ name: 'Bela Das', requestedStoreId: T.b }).expect(201)).body.loginId,
      );
    });

    it('Store A manager cannot list or approve a Store B signup', async () => {
      const list = await request(server()).get('/users/pending').set(as(tokens.mgrA)).expect(200);
      const ids = list.body.map((p: { id: string }) => p.id);
      expect(ids).toEqual(expect.arrayContaining([aSales, aStore]));
      expect(ids).not.toContain(bSales);
      await approve(tokens.mgrA, bSales).expect(403);
      await request(server()).post(`/users/${bSales}/reject`).set(as(tokens.mgrA)).send({ reason: 'no' }).expect(403);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: bSales }, include: { userStores: true } });
      expect(row.approvalStatus).toBe('pending');
      expect(row.userStores).toEqual([]);
    });

    it('Store A manager can approve a Store A salesperson — role, binding, approver, audit, notification', async () => {
      const res = await approve(tokens.mgrA, aSales).expect(201);
      expect(res.body.contactEmailDelivery).toBe('no_contact_email');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: aSales }, include: { userStores: true } });
      const mgr = await prisma.user.findUniqueOrThrow({ where: { email: T.mgrA } });
      expect(row).toMatchObject({ role: 'salesperson', isActive: true, approvalStatus: 'approved', approvedById: mgr.id });
      expect(row.approvedAt).toBeInstanceOf(Date);
      expect(row.userStores.map((l) => [l.storeId, l.isPrimary])).toEqual([[T.a, true]]);
      expect(await prisma.auditLog.count({ where: { action: 'user.approve', entityId: aSales, actorId: mgr.id } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: aSales, dedupeKey: 'signup-approved' } })).toBe(1);
      clearThrottle();
      await login(row.email, 'applicant-pass-1').expect(201);
    });

    it('Store A manager can approve a Store A storeperson', async () => {
      await approve(tokens.mgrA, aStore).expect(201);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: aStore }, include: { userStores: true } });
      expect(row.role).toBe('storeperson');
      expect(row.userStores.map((l) => l.storeId)).toEqual([T.a]);
    });

    it('may override between front-line roles, never upward or outside their stores', async () => {
      const id = await pendingId((await signup({ name: 'Omkar Pal' }).expect(201)).body.loginId);
      await approve(tokens.mgrA, id, { role: 'store_manager' }).expect(403);
      await approve(tokens.mgrA, id, { storeId: T.b }).expect(403);
      await approve(tokens.mgrA, id, { role: 'marketing' }).expect(201);
      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).role).toBe('marketing');
    });
  });

  /* ───────────────────────────── manager self-request ──────────────────────────── */

  describe('manager self-request', () => {
    afterAll(async () => {
      await request(server()).put('/users/signup-policy').set(as(tokens.ho)).send({ allowManagerSelfRequest: false });
    });

    it('is refused by default, and creates nothing', async () => {
      const before = await prisma.user.count({ where: { organisationId: T.org } });
      await signup({ requestedRole: 'store_manager' }).expect(400);
      expect(await prisma.user.count({ where: { organisationId: T.org } })).toBe(before);
      const preview = await request(server()).post('/auth/signup/preview').send({ organisationCode: T.slug }).expect(201);
      expect(preview.body.requestableRoles).toEqual(['salesperson', 'storeperson']);
    });

    it('when head office enables it, only head office can approve it', async () => {
      await request(server()).put('/users/signup-policy').set(as(tokens.mgrA)).send({ allowManagerSelfRequest: true }).expect(403);
      await request(server()).put('/users/signup-policy').set(as(tokens.ho)).send({ allowManagerSelfRequest: true }).expect(200);

      const res = await signup({ name: 'Manish Kulkarni', requestedRole: 'store_manager' }).expect(201);
      const id = await pendingId(res.body.loginId);

      const list = await request(server()).get('/users/pending').set(as(tokens.mgrA)).expect(200);
      expect(list.body.map((p: { id: string }) => p.id)).not.toContain(id);
      await approve(tokens.mgrA, id).expect(403);
      await approve(tokens.mgrA, id, { role: 'salesperson' }).expect(403); // not by approving it smaller

      await approve(tokens.ho, id).expect(201);
      const row = await prisma.user.findUniqueOrThrow({ where: { id }, include: { userStores: true } });
      expect(row.role).toBe('store_manager');
      expect(row.userStores.map((l) => l.storeId)).toEqual([T.a]);
    });

    it('keeps an existing pending manager request approvable by head office after the policy is switched off', async () => {
      const res = await signup({ name: 'Megha Rao', requestedRole: 'store_manager' }).expect(201);
      await request(server()).put('/users/signup-policy').set(as(tokens.ho)).send({ allowManagerSelfRequest: false }).expect(200);
      await approve(tokens.ho, await pendingId(res.body.loginId)).expect(201);
    });
  });

  /* ─────────────────────────── the approval transaction ────────────────────────── */

  describe('approval is one conditional transaction', () => {
    it('a replayed approval is a 409 and never binds twice', async () => {
      const id = await pendingId((await signup({ name: 'Rahul Sen' }).expect(201)).body.loginId);
      await approve(tokens.ho, id).expect(201);
      await approve(tokens.ho, id).expect(409);
      await request(server()).post(`/users/${id}/reject`).set(as(tokens.ho)).send({ reason: 'late' }).expect(409);
      expect(await prisma.userStore.count({ where: { userId: id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'user.approve', entityId: id } })).toBe(1);
    });

    it('reports the approval email as it actually went — a dry run when email is not set up', async () => {
      const res = await signup({ name: 'Gita Kaul', contactEmail: 'gita.kaul@example.com' }).expect(201);
      const approved = await approve(tokens.ho, await pendingId(res.body.loginId)).expect(201);
      expect(approved.body.contactEmailDelivery).toBe('dry_run');
      const row = await prisma.user.findUniqueOrThrow({ where: { email: res.body.loginId } });
      expect(row.contactEmail).toBe('gita.kaul@example.com');
      expect(row.email).not.toBe(row.contactEmail);
    });

    it('two approvals racing each other: exactly one wins', async () => {
      const id = await pendingId((await signup({ name: 'Ravi Iyer' }).expect(201)).body.loginId);
      const results = await Promise.all([approve(tokens.ho, id), approve(tokens.mgrA, id, { role: 'marketing' })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await prisma.userStore.count({ where: { userId: id } })).toBe(1);
    });

    it('an approver whose store was taken away after loading the queue is refused', async () => {
      const id = await pendingId((await signup({ name: 'Sunil Rane' }).expect(201)).body.loginId);
      const mgr = await prisma.user.findUniqueOrThrow({ where: { email: T.mgrA } });
      const listed = await request(server()).get('/users/pending').set(as(tokens.mgrA)).expect(200);
      expect(listed.body.map((p: { id: string }) => p.id)).toContain(id);

      // The token and the page both still say "Store A"; the database no longer does.
      const staleActor: AuthUser = {
        id: mgr.id, name: mgr.name, email: mgr.email, role: 'store_manager',
        organisationId: T.org, storeIds: [T.a], allStores: false,
      };
      await prisma.userStore.deleteMany({ where: { userId: mgr.id, storeId: T.a } });
      try {
        await expect(app.get(UsersService).approve(staleActor, id, {})).rejects.toMatchObject({ status: 403 });
        await approve(tokens.mgrA, id).expect(403);
      } finally {
        await prisma.userStore.create({ data: { userId: mgr.id, storeId: T.a, isPrimary: true } });
      }
      // A demotion counts the same way.
      await prisma.user.update({ where: { id: mgr.id }, data: { role: 'salesperson' } });
      try {
        await expect(app.get(UsersService).approve(staleActor, id, {})).rejects.toMatchObject({ status: 403 });
      } finally {
        await prisma.user.update({ where: { id: mgr.id }, data: { role: 'store_manager' } });
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).approvalStatus).toBe('pending');
    });

    it('refuses a store that closed between signup and approval', async () => {
      const id = await pendingId((await signup({ name: 'Chitra Bose', requestedStoreId: T.c }).expect(201)).body.loginId);
      await prisma.store.update({ where: { id: T.c }, data: { status: 'closed', isActive: false } });
      await approve(tokens.ho, id).expect(409);
      const row = await prisma.user.findUniqueOrThrow({ where: { id }, include: { userStores: true } });
      expect(row.approvalStatus).toBe('pending');
      expect(row.userStores).toEqual([]);
      // …and a closed store takes no new requests.
      await signup({ requestedStoreId: T.c }).expect(400);
    });

    it('re-issues the Login ID on a store override, past a collision, inside the transaction', async () => {
      const res = await signup({ name: 'Arjun Mehta' }).expect(201);
      expect(res.body.loginId).toMatch(new RegExp(`^arjun\\.andheri\\d*@${domain.replace(/\./g, '\\.')}$`));
      const id = await pendingId(res.body.loginId);
      // Someone already holds the ID the move to Bandra would produce first.
      await prisma.user.create({
        data: { email: `arjun.bandra@${domain}`, name: 'Arjun Other', organisationId: T.org, isActive: false },
      });
      const approved = await approve(tokens.ho, id, { storeId: T.b }).expect(201);
      expect(approved.body.loginId).toBe(`arjun.bandra2@${domain}`);
      expect(approved.body.email).toBe(`arjun.bandra2@${domain}`);
      const row = await prisma.user.findUniqueOrThrow({ where: { id }, include: { userStores: true } });
      expect(row.userStores.map((l) => l.storeId)).toEqual([T.b]);
    });
  });

  /* ─────────────────────────── rejection + reapplication ───────────────────────── */

  describe('rejection and reapplication', () => {
    it('records the reason, is terminal, and a fresh request shows the earlier decline', async () => {
      const phone = '9820077001';
      const first = await signup({ name: 'Pooja Shetty', phone }).expect(201);
      const id = await pendingId(first.body.loginId);
      await request(server()).post(`/users/${id}/reject`).set(as(tokens.mgrA)).send({ reason: 'Not on our roster' }).expect(201);

      const row = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ approvalStatus: 'rejected', isActive: false, rejectionReason: 'Not on our roster' });
      expect(row.rejectedAt).toBeInstanceOf(Date);
      await approve(tokens.ho, id).expect(409);
      await request(server()).patch(`/users/${id}/activate`).set(as(tokens.ho)).send({}).expect(409);
      clearThrottle();
      await login(first.body.loginId, 'applicant-pass-1').expect(401);

      const again = await signup({ name: 'Pooja Shetty', phone }).expect(201);
      expect(again.body.loginId).not.toBe(first.body.loginId);
      const list = await request(server()).get('/users/pending').set(as(tokens.mgrA)).expect(200);
      const fresh = list.body.find((p: { loginId: string }) => p.loginId === again.body.loginId);
      expect(fresh.priorRejection.reason).toBe('Not on our roster');
      expect(list.body.map((p: { id: string }) => p.id)).not.toContain(id);
    });
  });

  /* ────────────────────────────────── Login IDs ────────────────────────────────── */

  describe('Login IDs', () => {
    afterAll(async () => {
      await request(server()).put('/users/signup-policy').set(as(tokens.ho)).send({ loginIdTemplate: null });
    });

    it('two concurrent identical-name signups receive different Login IDs', async () => {
      clearThrottle();
      const results = await Promise.all(
        [0, 1, 2, 3].map(() => request(server()).post('/auth/signup').send(body({ name: 'Rohan Kapoor' }))),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const ids = results.map((r) => r.body.loginId);
      expect(new Set(ids).size).toBe(4);
      for (const loginId of ids) expect(loginId).toMatch(new RegExp(`^rohan\\.andheri\\d*@`));
    });

    it('follows a head-office template, and still suffixes concurrent namesakes', async () => {
      const put = await request(server())
        .put('/users/signup-policy')
        .set(as(tokens.ho))
        .send({ loginIdTemplate: `{firstname}@${T.slug}.{storeslug}.in` })
        .expect(200);
      expect(put.body.example).toBe(`priya@${T.slug}.mainstore.in`);

      clearThrottle();
      const results = await Promise.all(
        [0, 1].map(() => request(server()).post('/auth/signup').send(body({ name: 'Zara Khan' }))),
      );
      expect(results.map((r) => r.body.loginId).sort()).toEqual([
        `zara2@${T.slug}.andheri.in`,
        `zara@${T.slug}.andheri.in`,
      ]);
    });

    it('rejects templates that could collide with another tenant, or are malformed', async () => {
      const bad = ['{firstname}@eclat.{storeslug}.in', '{firstname}@{bogus}.in', 'priya@sss-jewels.in', '{firstname}', '{firstname}@a@b.in'];
      for (const loginIdTemplate of bad) {
        await request(server()).put('/users/signup-policy').set(as(tokens.ho)).send({ loginIdTemplate }).expect(400);
      }
      expect(loginIdTemplateError('{firstname}.{lastname}@{orgslug}.staff.in', T.slug)).toBeNull();
      expect(renderLoginId('{firstname}.{lastname}@{orgslug}.staff.in', { name: 'Priya', storeName: 'X', organisationSlug: T.slug })).toBe(
        `priya@${T.slug}.staff.in`,
      );
      await request(server()).get('/users/signup-policy').set(as(tokens.mgrA)).expect(403);
    });

    it('the preview is computed from the template alone — it never reveals who holds an ID', async () => {
      await request(server()).put('/users/signup-policy').set(as(tokens.ho)).send({ loginIdTemplate: null }).expect(200);
      const taken = (await signup({ name: 'Meera Pillai' }).expect(201)).body.loginId;
      const preview = (name: string, storeId: string = T.a) =>
        request(server()).post('/auth/signup/preview').send({ organisationCode: T.slug, requestedStoreId: storeId, name }).expect(201);

      const heldName = (await preview('Meera Pillai')).body;
      const freeName = (await preview('Veda Pillai')).body;
      // Same shape, both un-suffixed: the held ID is shown exactly as a free one is.
      expect(Object.keys(heldName).sort()).toEqual(Object.keys(freeName).sort());
      expect(heldName.loginIdPreview).toBe(taken);
      expect(heldName.loginIdSuffixExample).toBe(`meera.andheri2@${domain}`);
      expect(freeName.loginIdPreview).toBe(`veda.andheri@${domain}`);

      // The final ID is assigned by signup, not by the preview.
      const second = (await signup({ name: 'Meera Pillai' }).expect(201)).body.loginId;
      expect(second).not.toBe(taken);

      // Another tenant's store previews like a store that does not exist.
      const foreign = (await preview('Veda', OTHER.store)).body;
      const missing = (await preview('Veda', 'store_does_not_exist')).body;
      expect(foreign).toEqual(missing);
      expect(foreign.loginIdPreview).toBeNull();
    });
  });

  /* ─────────────────────────────── Eclat unchanged ─────────────────────────────── */

  describe('existing Eclat Login IDs', () => {
    it('are never rewritten by a template change, and still sign in byte-for-byte', async () => {
      const org = await prisma.organisation.findUniqueOrThrow({ where: { id: 'org_eclat' }, select: { settings: true } });
      eclatSettingsBefore = { value: org.settings };
      const snapshot = async () =>
        (await prisma.user.findMany({ where: { organisationId: 'org_eclat' }, select: { id: true, email: true }, orderBy: { id: 'asc' } }));

      // A legacy-domain handle, as production holds them.
      await prisma.user.create({
        data: {
          email: 'legacy.sss@eclatdiamonds.in', name: 'Legacy Probe', role: 'salesperson', organisationId: 'org_eclat',
          passwordHash: await bcrypt.hash(PASSWORD, 10), userStores: { create: { storeId: 'surat-main', isPrimary: true } },
        },
      });
      const before = await snapshot();

      clearThrottle();
      const eclatHo = (await login(ECLAT_HO).expect(201)).body.token;
      await request(server())
        .put('/users/signup-policy')
        .set(as(eclatHo))
        .send({ loginIdTemplate: '{firstname}@eclat.{storeslug}.in' })
        .expect(200);

      expect(await snapshot()).toEqual(before);
      for (const handle of [ECLAT_HO, 'aarav.mehta@caratsense.in', 'legacy.sss@eclatdiamonds.in']) {
        clearThrottle();
        const res = await login(handle).expect(201);
        expect(res.body.user.email).toBe(handle);
      }

      // Only a NEW person gets the new shape.
      const res = await signup({ name: 'Sssprobe Joshi', requestedStoreId: 'surat-main', organisationCode: 'eclat' }).expect(201);
      expect(res.body.loginId).toMatch(/^sssprobe\d*@eclat\.suratmain\.in$/);

      await request(server()).put('/users/signup-policy').set(as(eclatHo)).send({ loginIdTemplate: null }).expect(200);
      expect(await snapshot()).toEqual(expect.arrayContaining(before));
    });
  });
});
