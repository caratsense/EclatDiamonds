import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Module 17 — referral ACCOUNTS rework (client, 9 Oct 2026, item 12).
 *
 * The mandatory coupon-code workflow is gone: a referrer is an account for an
 * existing customer, identified by name/phone, and referred purchases are
 * recorded against the account by `referrerId`. Each purchase (customer, date,
 * invoice, amount) credits 5% of the bill BY DEFAULT — the percent is stored
 * per entry. The wallet is the record: purchases, redemptions and the running
 * balance; a redemption is applied against a later invoice and can never
 * overdraw. Legacy code-based rows must stay readable and usable.
 */
const PASSWORD = 'password123';

const F = {
  org: 'org_ref_acct',
  slug: 'ref-acct',
  store: 'store_ref_acct',
  manager: 'mgr.ref-acct@test.local',
  // A second organisation to prove referrerId cannot reach across tenants.
  orgB: 'org_ref_acct_b',
  slugB: 'ref-acct-b',
  hoB: 'ho.ref-acct-b@test.local',
};

describe('Referral accounts — record by referrer, wallet, redeem (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerToken = '';
  let hoBToken = '';
  let accountId = '';
  let accountCode = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (email: string) => {
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
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

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    await prisma.organisation.create({
      data: { id: F.org, name: 'Ref Acct Org', slug: F.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: F.store, name: 'REF-ACCT Store', city: 'Testville', organisationId: F.org },
    });
    await prisma.user.create({
      data: {
        email: F.manager, name: 'Manager Ref-Acct', role: 'store_manager', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: F.org,
        userStores: { create: { storeId: F.store, isPrimary: true } },
      },
    });

    await prisma.organisation.create({
      data: { id: F.orgB, name: 'Ref Acct Org B', slug: F.slugB, industryPackCode: 'jewellery' },
    });
    await prisma.user.create({
      data: {
        email: F.hoB, name: 'HO Ref-Acct B', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: F.orgB,
      },
    });

    managerToken = await login(F.manager);
    hoBToken = await login(F.hoB);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('creates a referrer account for an existing customer by name/phone', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/referral-codes')
      .set(auth(managerToken))
      .send({ referrerName: 'Meera Kapoor', referrerPhone: '9876500001', storeId: F.store });
    expect(r.status).toBe(201);
    expect(r.body.referrerName).toBe('Meera Kapoor');
    expect(r.body.referrerPhone).toBe('9876500001');
    expect(r.body.commissionBalance).toBe(0);
    accountId = r.body.id;
    // The row still carries an internally-minted code (legacy readability) —
    // but nothing below needs it except the explicit back-compat test.
    accountCode = r.body.code;
    expect(accountCode).toBeTruthy();
  });

  it('records a referred purchase against the account — 5% credit by default, stored per entry', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/referrals')
      .set(auth(managerToken))
      .send({
        referrerId: accountId,
        refereeName: 'Referred Customer One',
        refereePhone: '9876500002',
        billAmount: 10000,
        invoiceNo: 'INV-REF-001',
        billDate: '2026-10-01',
        storeId: F.store,
      });
    expect(r.status).toBe(201);
    expect(r.body.referrerName).toBe('Meera Kapoor');
    expect(r.body.commissionPct).toBe(5);
    expect(r.body.commissionAmount).toBe(500);
    expect(r.body.invoiceNo).toBe('INV-REF-001');
    expect(r.body.billDate).toBe('2026-10-01');
    expect(r.body.codeBalanceAfter).toBe(500);
  });

  it('a second referred purchase accumulates credit in the same wallet', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/referrals')
      .set(auth(managerToken))
      .send({
        referrerId: accountId,
        refereeName: 'Referred Customer Two',
        billAmount: 25000,
        invoiceNo: 'INV-REF-002',
        billDate: '2026-10-05',
        storeId: F.store,
      });
    expect(r.status).toBe(201);
    expect(r.body.commissionAmount).toBe(1250);
    expect(r.body.codeBalanceAfter).toBe(1750);
  });

  it('the wallet is the record: both purchases with dates, invoices, amounts, credits', async () => {
    const r = await request(app.getHttpServer())
      .get(`/loyalty/referral-codes/${accountId}/wallet`)
      .set(auth(managerToken));
    expect(r.status).toBe(200);
    expect(r.body.code.referrerName).toBe('Meera Kapoor');
    expect(r.body.totals).toEqual({ totalWallet: 1750, redeemed: 0, balance: 1750 });
    expect(r.body.referrals).toHaveLength(2);
    const invoices = r.body.referrals.map((x: { invoiceNo: string }) => x.invoiceNo).sort();
    expect(invoices).toEqual(['INV-REF-001', 'INV-REF-002']);
    const byInvoice = Object.fromEntries(
      r.body.referrals.map((x: { invoiceNo: string; billDate: string; billAmount: number; commissionAmount: number }) => [x.invoiceNo, x]),
    );
    expect(byInvoice['INV-REF-001'].billDate).toBe('2026-10-01');
    expect(byInvoice['INV-REF-001'].billAmount).toBe(10000);
    expect(byInvoice['INV-REF-001'].commissionAmount).toBe(500);
  });

  it('redeems part of the credit against a later invoice and draws the balance down', async () => {
    const r = await request(app.getHttpServer())
      .post(`/loyalty/referral-codes/${accountId}/payout`)
      .set(auth(managerToken))
      .send({ amount: 750, type: 'redeem', invoiceNo: 'INV-REF-003' });
    expect(r.status).toBe(201);
    expect(r.body.balanceAfter).toBe(1000);

    const wallet = await request(app.getHttpServer())
      .get(`/loyalty/referral-codes/${accountId}/wallet`)
      .set(auth(managerToken));
    expect(wallet.body.totals).toEqual({ totalWallet: 1750, redeemed: 750, balance: 1000 });
    expect(wallet.body.payouts).toHaveLength(1);
    expect(wallet.body.payouts[0].invoiceNo).toBe('INV-REF-003');
    expect(wallet.body.payouts[0].amount).toBe(750);
  });

  it('refuses to overdraw the wallet (400) and leaves the balance untouched', async () => {
    const r = await request(app.getHttpServer())
      .post(`/loyalty/referral-codes/${accountId}/payout`)
      .set(auth(managerToken))
      .send({ amount: 5000, type: 'redeem', invoiceNo: 'INV-REF-004' });
    expect(r.status).toBe(400);
    const row = await prisma.referralCode.findUnique({ where: { id: accountId } });
    expect(Number(row!.commissionBalance)).toBe(1000);
  });

  it('legacy flow: the minted code still resolves the same account', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/referrals')
      .set(auth(managerToken))
      .send({
        code: accountCode,
        refereeName: 'Referred Customer Three',
        billAmount: 2000,
        storeId: F.store,
      });
    expect(r.status).toBe(201);
    expect(r.body.commissionAmount).toBe(100);
    expect(r.body.codeBalanceAfter).toBe(1100);
  });

  it('refuses a purchase naming neither referrerId nor code (400)', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/referrals')
      .set(auth(managerToken))
      .send({ refereeName: 'Nobody Referred Me', billAmount: 1000, storeId: F.store });
    expect(r.status).toBe(400);
  });

  it('a referrerId from another organisation is not found (404) and credits nothing', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/referrals')
      .set(auth(hoBToken))
      .send({ referrerId: accountId, refereeName: 'Cross Org Referee', billAmount: 99999 });
    expect(r.status).toBe(404);
    const row = await prisma.referralCode.findUnique({ where: { id: accountId } });
    expect(Number(row!.commissionBalance)).toBe(1100);
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [F.org, F.orgB]) {
    await prisma.referralPayout.deleteMany({ where: { code: { organisationId: org } } });
    await prisma.referral.deleteMany({ where: { code: { organisationId: org } } });
    await prisma.referralCode.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
  }
  await prisma.organisation.deleteMany({ where: { slug: { in: [F.slug, F.slugB] } } });
}
