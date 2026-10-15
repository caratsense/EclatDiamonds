import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

const pdfParse: (data: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');

/**
 * The customer, the address and the payments on a saved quote.
 *
 *  1. Editable after saving, and NOT the price: no revision bump.
 *  2. They print: the typed address wins over the customer record, and each
 *     payment shows with its transaction reference and the balance left.
 *  3. Money in can never be more than the quote; a GSTIN has to look like one.
 *  4. A salesperson cannot touch a colleague's quote this way either.
 *  5. The customer's own address (13 Oct) survives create → read → edit and
 *     prints under their name; the phone may be a foreign number, stored
 *     normalised, while an Indian mobile passes through unchanged.
 *  6. The WHOLE customer block — name, phone and address (14 Oct) — can be
 *     corrected after the quote exists, on a quote that has already been
 *     shared, and all three reach the regenerated PDF. The name cannot be
 *     emptied, and a corrected phone is normalised like a created one.
 */

const PASSWORD = 'password123';
const A = { org: 'org_qd', store: 'store_qd', rep: 'rep.qd@qd.local', rep2: 'rep2.qd@qd.local' };

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.productInteraction.deleteMany({ where: { organisationId: A.org } });
  await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: A.org } } });
  await prisma.quoteRedeemableStore.deleteMany({ where: { quote: { organisationId: A.org } } });
  await prisma.quote.deleteMany({ where: { organisationId: A.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: A.org } });
  await prisma.mergeCandidate.deleteMany({ where: { organisationId: A.org } });
  await prisma.party.deleteMany({ where: { organisationId: A.org } });
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
    // Three quotes, one per standing the customer edit has to survive: shared
    // (the bill-to / payments tests below use it), shared again for the
    // customer block, and accepted — the one standing that could be protected.
    for (const [id, ref, status] of [
      ['q_qd', 'QT-QD-1', 'shared'],
      ['q_qd_cust', 'QT-QD-2', 'shared'],
      ['q_qd_acc', 'QT-QD-3', 'accepted'],
    ] as const) {
      await prisma.quote.create({
        data: {
          id, organisationId: A.org, storeId: A.store, ref,
          customerName: 'Details Customer', phone: '919812370002', status,
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
    }
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

  /* ------------------------- the customer's own address + a foreign phone */

  it('a foreign customer: the phone is accepted and stored normalised, the address rides the quote', async () => {
    const created = await request(server())
      .post('/quotes')
      .set(auth(rep))
      .send({
        storeId: A.store,
        customerName: 'Overseas Customer',
        phone: '+44 20 7946-0958',
        customerAddress: ' 221B Baker Street, London ',
        lines: [{ description: 'Ring', karat: 18, weightGrams: 5, goldRatePerGram: 10_000, makingCharges: 5_000 }],
      })
      .expect(201);
    // Formatting is stripped; the + survives so the number stays dialable.
    expect(created.body.phone).toBe('+442079460958');
    expect(created.body.customerAddress).toBe('221B Baker Street, London');

    // Reopening reads the same thing back.
    const read = await request(server()).get(`/quotes/${created.body.id}`).set(auth(rep)).expect(200);
    expect(read.body.phone).toBe('+442079460958');
    expect(read.body.customerAddress).toBe('221B Baker Street, London');

    // It prints under the customer's name on the PDF.
    const file = await request(server())
      .get(`/quotes/${created.body.id}/pdf`).set(auth(rep)).buffer(true).parse(binary).expect(200);
    const text = (await pdfParse(file.body as Buffer)).text;
    expect(text).toContain('221B Baker Street, London');

    // Edited through the details route, like the bill-to block; no revision bump.
    const edited = await request(server())
      .patch(`/quotes/${created.body.id}/details`)
      .set(auth(rep))
      .send({ customerAddress: '42 Marine Drive, Mumbai' })
      .expect(200);
    expect(edited.body.revision).toBe(1);
    expect(edited.body.customerAddress).toBe('42 Marine Drive, Mumbai');

    // And an empty string clears it.
    const cleared = await request(server())
      .patch(`/quotes/${created.body.id}/details`)
      .set(auth(rep))
      .send({ customerAddress: '' })
      .expect(200);
    expect(cleared.body.customerAddress).toBe('');
  });

  it('a plain 10-digit Indian mobile still passes unchanged; junk still rejects', async () => {
    const created = await request(server())
      .post('/quotes')
      .set(auth(rep))
      .send({
        storeId: A.store, customerName: 'Local Customer', phone: '9812370042',
        lines: [{ description: 'Ring', karat: 18, weightGrams: 5, goldRatePerGram: 10_000, makingCharges: 5_000 }],
      })
      .expect(201);
    expect(created.body.phone).toBe('9812370042');

    for (const phone of ['12345', 'call me 9812370042', '+91 98123 70042 x12', '1234567890123456']) {
      await request(server())
        .post('/quotes')
        .set(auth(rep))
        .send({
          storeId: A.store, customerName: 'Bad Phone', phone,
          lines: [{ description: 'Ring', karat: 18, weightGrams: 5, goldRatePerGram: 10_000, makingCharges: 5_000 }],
        })
        .expect(400);
    }
  });

  /* ----------------------------- the whole customer block, after creation */

  it('name, phone and address all change after the quote exists, and all three print', async () => {
    const res = await request(server())
      .patch('/quotes/q_qd_cust/details')
      .set(auth(rep))
      .send({
        customerName: '  Priya Raghunathan  ',
        phone: '+44 20 7946-0958',
        customerAddress: ' 221B Baker Street, London ',
      })
      .expect(200);
    // The view answers with the corrected customer, trimmed and normalised…
    expect(res.body.customer).toBe('Priya Raghunathan');
    expect(res.body.phone).toBe('+442079460958');
    expect(res.body.customerAddress).toBe('221B Baker Street, London');
    // …and nothing about the price moved, so the quote is still the same offer.
    expect(res.body.revision).toBe(1);
    expect(res.body.totals.grandTotal).toBe(100_000);

    // Reopening reads the correction back, not the name it was raised with.
    const read = await request(server()).get('/quotes/q_qd_cust').set(auth(rep)).expect(200);
    expect(read.body.customer).toBe('Priya Raghunathan');
    expect(read.body.phone).toBe('+442079460958');
    expect(read.body.customerAddress).toBe('221B Baker Street, London');

    // The PDF is generated from the quote each time it is asked for, so the
    // regenerated one carries all three — this is what the customer receives.
    const file = await request(server())
      .get('/quotes/q_qd_cust/pdf').set(auth(rep)).buffer(true).parse(binary).expect(200);
    const text = (await pdfParse(file.body as Buffer)).text;
    for (const s of ['Priya Raghunathan', '+442079460958', '221B Baker Street, London']) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('Details Customer');

    // The audit keeps what it was, so a corrected name is not a silent one.
    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'quotes.details_edited', entityId: 'q_qd_cust' },
    });
    expect(audit?.metadata).toMatchObject({
      previousCustomerName: 'Details Customer',
      previousPhone: '919812370002',
      customerName: 'Priya Raghunathan',
      phone: '+442079460958',
    });
  });

  it('being shared already does not close the customer block — only one field need be sent', async () => {
    // q_qd_cust is status `shared`, and the test above edited it regardless.
    const before = await request(server()).get('/quotes/q_qd_cust').set(auth(rep)).expect(200);
    expect(before.body.status).toBe('shared');

    // A field left out is left as it is: correcting the phone alone must not
    // wipe the name or the address typed with it a moment ago.
    const res = await request(server())
      .patch('/quotes/q_qd_cust/details')
      .set(auth(rep))
      .send({ phone: '9812370099' })
      .expect(200);
    expect(res.body.phone).toBe('9812370099');
    expect(res.body.customer).toBe('Priya Raghunathan');
    expect(res.body.customerAddress).toBe('221B Baker Street, London');
  });

  /**
   * What was FOUND, not a rule invented here: the details route deliberately
   * stays open on an accepted quote (the service says so — money, and the
   * spelling for the certificate, both arrive after the order is booked). The
   * PRICE route is the one that refuses, and that refusal is asserted here too
   * so the difference between the two is on the record.
   */
  it('an accepted quote still accepts a customer correction, though not a new price', async () => {
    const res = await request(server())
      .patch('/quotes/q_qd_acc/details')
      .set(auth(rep))
      .send({ customerName: 'Accepted Customer', customerAddress: '9 Linking Road' })
      .expect(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.customer).toBe('Accepted Customer');
    expect(res.body.customerAddress).toBe('9 Linking Road');

    await request(server())
      .patch('/quotes/q_qd_acc')
      .set(auth(rep))
      .send({ additionalDiscount: 500 })
      .expect(400);
  });

  it('the name can be corrected but never emptied, and a junk phone is refused', async () => {
    for (const body of [
      { customerName: '' },
      { customerName: '   ' },
      { customerName: '46466' }, // digits are not a name
      { phone: '12345' },
      { phone: 'call me later' },
    ]) {
      await request(server())
        .patch('/quotes/q_qd_cust/details')
        .set(auth(rep))
        .send(body)
        .expect(400);
    }
    // Still the last good values — a refused edit changes nothing.
    const read = await request(server()).get('/quotes/q_qd_cust').set(auth(rep)).expect(200);
    expect(read.body.customer).toBe('Priya Raghunathan');
    expect(read.body.phone).toBe('9812370099');
  });

  it("a salesperson cannot rename a colleague's customer", async () => {
    await request(server())
      .patch('/quotes/q_qd_cust/details')
      .set(auth(rep2))
      .send({ customerName: 'Hijacked' })
      .expect(404);
  });
});
