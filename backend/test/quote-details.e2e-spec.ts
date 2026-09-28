import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

const pdfParse: (data: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');

/**
 * Address and payments on a saved quote.
 *
 *  1. Editable after saving, and NOT the price: no revision bump, so an
 *     approval given for this amount still stands.
 *  2. They print: the typed address wins over the customer record, and each
 *     payment shows with its transaction reference and the balance left.
 *  3. Money in can never be more than the quote; a GSTIN has to look like one.
 *  4. A salesperson cannot touch a colleague's quote this way either.
 */

const PASSWORD = 'password123';
const A = { org: 'org_qd', store: 'store_qd', rep: 'rep.qd@qd.local', rep2: 'rep2.qd@qd.local' };

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: A.org } } });
  await prisma.quote.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Quote address and payments (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let rep: string;
  let rep2: string;
  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

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

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'QD', slug: 'qd', industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Counter', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
    });
    for (const [id, email] of [['u_qd_rep', A.rep], ['u_qd_rep2', A.rep2]] as const) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: 'salesperson', passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }
    await prisma.quote.create({
      data: {
        id: 'q_qd', organisationId: A.org, storeId: A.store, ref: 'QT-QD-1',
        customerName: 'Details Customer', phone: '919812370002', status: 'shared',
        grandTotal: 100_000, taxableAmount: 97_087.38, gstAmount: 2_912.62,
        assignedRepId: 'u_qd_rep',
        lines: {
          create: {
            description: 'Ring', karat: 18, weightGrams: 5, goldRatePerGram: 10_000,
            makingCharges: 47_087.38, stoneCharges: 0,
          },
        },
      },
    });
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    rep = await login(A.rep);
    rep2 = await login(A.rep2);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('saves address and payments without touching the price or the revision', async () => {
    const res = await request(server())
      .patch('/quotes/q_qd/details')
      .set(auth(rep))
      .send({
        billTo: { address: ' 12 Hill Road, Bandra ', state: 'Maharashtra', gstin: '27ABCDE1234F1Z5', pan: '' },
        payments: [
          { mode: 'upi', amount: 25_000, reference: 'UTR412345678901', date: '2026-09-28' },
          { mode: 'cash', amount: 5_000 },
        ],
      })
      .expect(200);
    expect(res.body.revision).toBe(1);
    expect(res.body.totals.grandTotal).toBe(100_000);
    expect(res.body.billTo).toEqual({ address: '12 Hill Road, Bandra', state: 'Maharashtra', gstin: '27ABCDE1234F1Z5' });
    expect(res.body.payments).toHaveLength(2);
    const audit = await prisma.auditLog.findFirst({ where: { organisationId: A.org, action: 'quotes.details_edited' } });
    expect(audit).toBeTruthy();
  });

  it('prints the typed address, each payment with its reference, and the balance', async () => {
    const file = await request(server()).get('/quotes/q_qd/pdf').set(auth(rep)).buffer(true).parse(binary).expect(200);
    const text = (await pdfParse(file.body as Buffer)).text;
    for (const s of ['12 Hill Road, Bandra', '27ABCDE1234F1Z5', 'UPI UTR412345678901', '25,000.00', 'Cash', '30,000.00', '70,000.00']) {
      expect(text).toContain(s);
    }
  });

  it('refuses more money than the quote, and a GSTIN that is not one', async () => {
    await request(server())
      .patch('/quotes/q_qd/details')
      .set(auth(rep))
      .send({ payments: [{ mode: 'card', amount: 100_001 }] })
      .expect(400);
    await request(server())
      .patch('/quotes/q_qd/details')
      .set(auth(rep))
      .send({ billTo: { gstin: 'NOTAGSTIN' } })
      .expect(400);
  });

  it("a salesperson cannot edit a colleague's quote", async () => {
    await request(server())
      .patch('/quotes/q_qd/details')
      .set(auth(rep2))
      .send({ billTo: { address: 'x' } })
      .expect(404);
  });
});
