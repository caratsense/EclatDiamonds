import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Signing in with what a person remembers.
 *
 * A Login ID is generated from the store's name, and staff do not remember
 * theirs: they set a password, typed their own email or number, and were told
 * the account did not exist. So the mobile number or personal email given at
 * sign-up works as well.
 *
 *  1. The Login ID still works, exactly as before.
 *  2. The mobile number works, with or without +91.
 *  3. The personal email works.
 *  4. Neither is unique. Two people on one number are told apart by password;
 *     two people sharing number AND password are refused rather than guessed.
 *  5. A wrong password, an unknown handle and a switched-off account all get
 *     the same answer.
 */

const ORG = 'org_lbm';
const STORE = 'store_lbm';
const login = (app: INestApplication, email: string, password: string) =>
  request(app.getHttpServer()).post('/auth/login').send({ email, password });

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.userStore.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}

describe('Login by mobile number or personal email (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;

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

    await prisma.organisation.create({ data: { id: ORG, name: 'LBM', slug: 'lbm', industryPackCode: 'jewellery' } });
    await prisma.store.create({
      data: { id: STORE, name: 'Counter', city: 'Mumbai', organisationId: ORG, timezone: 'Asia/Kolkata' },
    });
    const person = async (
      id: string,
      password: string,
      extra: { phone?: string; contactEmail?: string; isActive?: boolean },
    ) =>
      prisma.user.create({
        data: {
          id, email: `${id}.counter@lbm.local`, name: id, role: 'salesperson',
          passwordHash: await bcrypt.hash(password, 10), isActive: extra.isActive ?? true,
          approvalStatus: 'approved', organisationId: ORG,
          phone: extra.phone, contactEmail: extra.contactEmail,
          userStores: { create: { storeId: STORE, isPrimary: true } },
        },
      });
    await person('lbm_anita', 'anita-pass-1', { phone: '+91 98111 00001', contactEmail: 'Anita@Home.example' });
    // Two people who gave the same number, different passwords.
    await person('lbm_ravi', 'ravi-pass-1', { phone: '9811100002' });
    await person('lbm_sita', 'sita-pass-1', { phone: '9811100002' });
    // Two people who share number and password: not one identity.
    await person('lbm_twin_a', 'same-pass-1', { phone: '9811100003' });
    await person('lbm_twin_b', 'same-pass-1', { phone: '9811100003' });
    await person('lbm_left', 'left-pass-1', { phone: '9811100004', isActive: false });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('the Login ID still works', async () => {
    const res = await login(app, 'lbm_anita.counter@lbm.local', 'anita-pass-1').expect(201);
    expect(res.body.user.name).toBe('lbm_anita');
  });

  it('the mobile number works, however it is typed', async () => {
    // Two spellings, not four: sign-in is rate limited per address and the whole
    // suite has to fit inside one window.
    for (const typed of ['9811100001', '+91 98111 00001']) {
      const res = await login(app, typed, 'anita-pass-1').expect(201);
      expect(res.body.user.name).toBe('lbm_anita');
    }
  });

  it('the personal email works, in any case', async () => {
    const res = await login(app, 'anita@home.example', 'anita-pass-1').expect(201);
    expect(res.body.user.name).toBe('lbm_anita');
  });

  it('two people on one number are told apart by their password', async () => {
    expect((await login(app, '9811100002', 'ravi-pass-1').expect(201)).body.user.name).toBe('lbm_ravi');
    expect((await login(app, '9811100002', 'sita-pass-1').expect(201)).body.user.name).toBe('lbm_sita');
  });

  it('refuses rather than guesses, and never says why', async () => {
    const answers = await Promise.all([
      login(app, '9811100003', 'same-pass-1'), // two people, one number, one password
      login(app, '9811100001', 'wrong-pass-1'), // wrong password
      login(app, '9811100009', 'anita-pass-1'), // nobody has this number
      login(app, '9811100004', 'left-pass-1'), // switched off
    ]);
    expect(answers).toHaveLength(4);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid credentials');
    }
  });
});
