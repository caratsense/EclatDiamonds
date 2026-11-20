import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Three holes found in the 12 Oct review, older than the PRs it covered, and
 * head office's switch for the live in-store count. Runs on the seeded demo
 * organisation and leaves it as it found it.
 *
 *  1. A store manager cannot pull a salesperson over from another branch
 *     (PATCH /users/:id/stores), and head office cannot link somebody to
 *     another organisation's store.
 *  2. One head office cannot set another head office's password.
 *  3. A referral credit names a real bill, once, and is never on more than the
 *     bill came to; a salesperson cannot credit a bill that has not arrived.
 *  4. Only head office switches the live "in store now" count.
 */
const PASSWORD = 'password123';
const ORG = 'org_eclat';
const OTHER = { org: 'org_guard_x', store: 'store_guard_x' };
const HO2 = 'u-guard-ho2';
const SALE = 'GUARD-INV-1';

describe('Scope and credit guards (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const t: Record<string, string> = {};
  let referrerId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH = '100';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: OTHER.org, name: 'Guard X', slug: 'guard-x' } });
    await prisma.store.create({ data: { id: OTHER.store, name: 'X', city: 'X', organisationId: OTHER.org } });
    await prisma.user.create({
      data: {
        id: HO2,
        email: 'second.ho@guard.local',
        name: 'Second Head Office',
        role: 'head_office',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: true,
        approvalStatus: 'approved',
        organisationId: ORG,
      },
    });
    referrerId = (
      await prisma.referralCode.create({
        data: { organisationId: ORG, code: 'GUARD-REF', referrerName: 'Guard Referrer', storeId: 'surat-main' },
      })
    ).id;
    await prisma.sale.create({
      data: { organisationId: ORG, storeId: 'surat-main', docNo: SALE, docDate: new Date(), totalAmount: 50000 },
    });

    for (const [who, email] of [
      ['ho', 'head.office@caratsense.in'],
      ['karan', 'karan.malhotra@caratsense.in'],
      ['aarav', 'aarav.mehta@caratsense.in'],
      ['priya', 'priya.rep@caratsense.in'],
    ]) {
      t[who] = (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    }
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ------------------------------------------------- 1. branch sets */

  it("a store manager cannot pull another branch's salesperson into their own", async () => {
    // Karan manages Mumbai Bandra; Priya works at Surat Main.
    await request(server())
      .patch('/users/u-rep-priya/stores')
      .set(auth('karan'))
      .send({ storeIds: ['mumbai-bandra'] })
      .expect(403);
    const links = await prisma.userStore.findMany({ where: { userId: 'u-rep-priya' } });
    expect(links.map((l) => l.storeId)).toEqual(['surat-main']);
  });

  it("head office cannot link a person to another organisation's store", async () => {
    await request(server())
      .patch('/users/u-rep-priya/stores')
      .set(auth('ho'))
      .send({ storeIds: [OTHER.store] })
      .expect(404);
    expect(await prisma.userStore.count({ where: { storeId: OTHER.store } })).toBe(0);
  });

  /* ------------------------------------------------- 2. head office password */

  it("one head office cannot set another head office's password", async () => {
    const before = await prisma.user.findUnique({ where: { id: HO2 } });
    await request(server())
      .post('/auth/reset-password')
      .set(auth('ho'))
      .send({ userId: HO2, newPassword: 'taken-over-123' })
      .expect(403);
    const after = await prisma.user.findUnique({ where: { id: HO2 } });
    expect(after?.passwordHash).toBe(before?.passwordHash);
  });

  /* ------------------------------------------------- 3. referral credit */

  const credit = (who: string, body: Record<string, unknown>) =>
    request(server())
      .post('/loyalty/referrals')
      .set(auth(who))
      .send({ referrerId, refereeName: 'Guard Referee', storeId: 'surat-main', ...body });

  it('a referral credit names its bill', async () => {
    await credit('aarav', { billAmount: 1000 }).expect(400);
  });

  it('a salesperson cannot credit a bill that has not arrived', async () => {
    const r = await credit('priya', { billAmount: 1000, invoiceNo: 'NO-SUCH-BILL' }).expect(400);
    expect(r.body.message).toMatch(/has not reached CaratSpace/);
  });

  it('a credit is never on more than the bill came to', async () => {
    const r = await credit('priya', { billAmount: 90000, invoiceNo: SALE }).expect(400);
    expect(r.body.message).toMatch(/cannot be on more than that/);
  });

  it('one bill earns one credit', async () => {
    await credit('priya', { billAmount: 50000, invoiceNo: SALE }).expect(201);
    await credit('aarav', { billAmount: 50000, invoiceNo: SALE }).expect(409);
    const code = await prisma.referralCode.findUnique({ where: { id: referrerId } });
    expect(Number(code!.commissionBalance)).toBe(2500);
  });

  /* ------------------------------------------------- 4. live occupancy */

  it('only head office switches the live in-store count', async () => {
    await request(server()).put('/checkins/settings').set(auth('aarav')).send({ liveOccupancy: false }).expect(403);

    await request(server()).put('/checkins/settings').set(auth('ho')).send({ liveOccupancy: false }).expect(200);
    const off = await request(server()).get('/config/bootstrap').set(auth('aarav')).expect(200);
    expect(off.body.organisation.settings.checkins.liveOccupancy).toBe(false);
    const trail = await prisma.auditLog.findFirst({
      where: { organisationId: ORG, action: 'checkins.settings_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(trail?.metadata).toEqual({ liveOccupancy: false });

    await request(server()).put('/checkins/settings').set(auth('ho')).send({ liveOccupancy: true }).expect(200);
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.referral.deleteMany({ where: { code: { code: 'GUARD-REF', organisationId: ORG } } });
  await prisma.referralCode.deleteMany({ where: { code: 'GUARD-REF', organisationId: ORG } });
  await prisma.sale.deleteMany({ where: { organisationId: ORG, docNo: SALE } });
  await prisma.auditLog.deleteMany({ where: { actorId: HO2 } });
  await prisma.user.deleteMany({ where: { id: HO2 } });
  await prisma.userStore.deleteMany({ where: { storeId: OTHER.store } });
  await prisma.store.deleteMany({ where: { organisationId: OTHER.org } });
  await prisma.organisation.deleteMany({ where: { id: OTHER.org } });
}
