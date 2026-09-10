import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Regression guard for the Phase C blocker.
 *
 * `@RateLimit('auth')` used to sit on the AuthController CLASS. The `auth`
 * bucket is 10/min, and `CategoryThrottlerGuard.getTracker` keys an
 * AUTHENTICATED request on the ORGANISATION — so every route on the controller,
 * including `GET /auth/me`, was capped at ten requests a minute for the whole
 * tenant. The frontend session gate calls `/auth/me` on every page load, so a
 * few staff opening the app together were 429'd back to the login screen.
 *
 * The two properties below have to hold TOGETHER: it is easy to fix the outage
 * by loosening the credential routes, and that would be a security regression.
 * So one test proves the public routes are still throttled and the other proves
 * the authenticated session read is not.
 *
 * ORDER MATTERS. The public-route test deliberately exhausts this IP's `auth`
 * bucket, so it runs last; everything needing a login happens before it.
 */
const T = {
  org: 'org_authrl',
  store: 'store_authrl',
  slug: 'authrl',
  email: 'rl.user@authrl.local',
  password: 'password123',
};

describe('auth rate-limit classification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await teardown(prisma);
    await prisma.organisation.create({ data: { id: T.org, name: 'Auth RL', slug: T.slug } });
    await prisma.store.create({
      data: { id: T.store, name: 'Auth RL Store', city: 'Testville', organisationId: T.org },
    });
    await prisma.user.create({
      data: {
        email: T.email,
        name: 'RL User',
        role: 'head_office',
        passwordHash: await bcrypt.hash(T.password, 10),
        isActive: true,
        approvalStatus: 'approved',
        organisationId: T.org,
        userStores: { create: { storeId: T.store, isPrimary: true } },
      },
    });

    // One login — deliberately the only credential-route call before the last test.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: T.email, password: T.password });
    expect(login.status).toBeLessThan(400);
    token = login.body.token;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('GET /auth/me survives well past the 10/min auth limit', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);
      codes.push(res.status);
    }

    // 15 > the auth bucket's 10. Before the fix this read
    // 200×10 then 429×5, and the session gate bounced the user to /login.
    expect(codes.filter((c) => c === 429)).toHaveLength(0);
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it('POST /auth/change-password is not on the credential bucket either', async () => {
    // Wrong current password on purpose: this asserts the THROTTLE
    // classification, not the password logic, so it must not mutate anything.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'definitely-not-it', newPassword: 'anotherpassword123' });
      codes.push(res.status);
    }
    // Rejected on the merits (4xx), never throttled away as a credential route.
    expect(codes.filter((c) => c === 429)).toHaveLength(0);
  });

  it('public credential routes are STILL throttled (runs last: exhausts the bucket)', async () => {
    // A non-existent account, so the per-account lockout in AuthService cannot
    // interfere with what is being measured here.
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@authrl.local', password: 'wrong-password' });
      codes.push(res.status);
      if (res.status === 429) break;
    }

    expect(codes).toContain(429);
    // And it bites early — a credential-guessing budget, not the 300/min default.
    expect(codes.indexOf(429)).toBeLessThan(20);
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: T.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: T.org } } });
  await prisma.user.deleteMany({ where: { organisationId: T.org } });
  await prisma.store.deleteMany({ where: { organisationId: T.org } });
  await prisma.organisation.deleteMany({ where: { slug: T.slug } });
}
