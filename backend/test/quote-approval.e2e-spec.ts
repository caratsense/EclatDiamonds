import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Approval before a quote leaves the building.
 *
 * Until now `share()` guarded one thing — that a phone number exists — so any
 * amount could be WhatsApped to a customer by anybody who could open the screen.
 * The properties pinned here:
 *
 *  1. OFF BY DEFAULT. A tenant with no threshold behaves exactly as before. This
 *     is what makes the change safe to deploy before anybody picks a number.
 *
 *  2. OVER THE THRESHOLD, SHARING IS REFUSED. Not warned about — refused, at the
 *     one door out to a customer.
 *
 *  3. YOU CANNOT APPROVE YOUR OWN. Unless the tenant deliberately allows it.
 *
 *  4. APPROVAL IS FOR AN AMOUNT, NOT A QUOTE. This is the one that matters most:
 *     approve at one price, edit it upward, and sharing is refused again. Without
 *     the snapshot the whole step would be decoration.
 *
 *  5. REJECTION NEEDS A REASON, and a corrected quote can be re-submitted.
 *
 *  6. A SALESPERSON CANNOT DECIDE, and cannot change the policy.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_qa_a', slug: 'qa-a', store: 'store_qa_a',
  ho: 'ho.qa@qa-a.local', mgr: 'mgr.qa@qa-a.local', rep: 'rep.qa@qa-a.local',
};

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.quoteApprovalSettings.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: A.org } } });
  await prisma.quote.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Quote approval (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoA: string;
  let mgrA: string;
  let repA: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A quote big enough to trip a threshold, owned by the rep. */
  const makeQuote = async (id: string, ref: string, total: number) => {
    await prisma.quote.create({
      data: {
        id, organisationId: A.org, storeId: A.store, ref,
        customerName: 'Approval Customer', phone: '919812370001',
        status: 'draft', grandTotal: total, taxableAmount: total,
        assignedRepId: 'u_qa_rep',
      },
    });
    return id;
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
      data: { id: A.org, name: 'QA A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Counter', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
    });
    for (const [id, email, role] of [
      ['u_qa_ho', A.ho, 'head_office'],
      ['u_qa_mgr', A.mgr, 'store_manager'],
      ['u_qa_rep', A.rep, 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoA = await login(A.ho);
    mgrA = await login(A.mgr);
    repA = await login(A.rep);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('is off until a threshold is set — nothing changes for an existing tenant', async () => {
    const q = await makeQuote('q_qa_small', 'QT-QA-1', 50_000);
    const gate = await request(server()).get(`/quotes/${q}/approval`).set(auth(repA)).expect(200);
    expect(gate.body.required).toBe(false);
    expect(gate.body.cleared).toBe(true);
  });

  it('only head office sets the policy', async () => {
    await request(server())
      .put('/quotes/approval/settings')
      .set(auth(repA))
      .send({ valueThreshold: 100_000 })
      .expect(403);
    await request(server())
      .put('/quotes/approval/settings')
      .set(auth(hoA))
      .send({ valueThreshold: 100_000 })
      .expect(200);
  });

  it('under the threshold still needs nothing', async () => {
    const gate = await request(server())
      .get('/quotes/q_qa_small/approval')
      .set(auth(repA))
      .expect(200);
    expect(gate.body.required).toBe(false);
    expect(gate.body.cleared).toBe(true);
  });

  it('over the threshold, sharing is refused — not merely warned about', async () => {
    await makeQuote('q_qa_big', 'QT-QA-2', 145_000);
    const gate = await request(server())
      .get('/quotes/q_qa_big/approval')
      .set(auth(repA))
      .expect(200);
    expect(gate.body.required).toBe(true);
    expect(gate.body.cleared).toBe(false);

    const share = await request(server())
      .post('/quotes/q_qa_big/share')
      .set(auth(repA));
    expect(share.status).toBe(403);
    expect(JSON.stringify(share.body)).toMatch(/approval/i);
  });

  it('a salesperson may ask but not decide', async () => {
    await request(server())
      .post('/quotes/q_qa_big/request-approval')
      .set(auth(repA))
      .expect(201);
    const q = await prisma.quote.findUnique({ where: { id: 'q_qa_big' } });
    expect(q?.status).toBe('pending_approval');
    expect(q?.requestedById).toBe('u_qa_rep');

    await request(server())
      .post('/quotes/q_qa_big/decide')
      .set(auth(repA))
      .send({ approve: true })
      .expect(403);
  });

  it('it appears on the manager’s pending list', async () => {
    const res = await request(server())
      .get('/quotes/approval/pending')
      .set(auth(mgrA))
      .expect(200);
    const row = res.body.find((r: { id: string }) => r.id === 'q_qa_big');
    expect(row).toBeTruthy();
    expect(row.amount).toBe(145000);
    expect(row.requestedByName).toBeTruthy();
  });

  it('rejecting needs a reason, and the reason is kept', async () => {
    await request(server())
      .post('/quotes/q_qa_big/decide')
      .set(auth(mgrA))
      .send({ approve: false })
      .expect(400);

    await request(server())
      .post('/quotes/q_qa_big/decide')
      .set(auth(mgrA))
      .send({ approve: false, reason: 'Making charge is below floor' })
      .expect(201);

    const q = await prisma.quote.findUnique({ where: { id: 'q_qa_big' } });
    expect(q?.status).toBe('rejected');
    expect(q?.decisionReason).toContain('below floor');
    expect(q?.approvedTotal).toBeNull();

    const share = await request(server()).post('/quotes/q_qa_big/share').set(auth(repA));
    expect(share.status).toBe(403);
  });

  it('a corrected quote can be resubmitted, and the old decision is cleared', async () => {
    await request(server())
      .post('/quotes/q_qa_big/request-approval')
      .set(auth(repA))
      .expect(201);
    const q = await prisma.quote.findUnique({ where: { id: 'q_qa_big' } });
    expect(q?.status).toBe('pending_approval');
    expect(q?.decisionReason).toBeNull();
    expect(q?.decidedById).toBeNull();
  });

  it('approving records who, when and for how much', async () => {
    await request(server())
      .post('/quotes/q_qa_big/decide')
      .set(auth(mgrA))
      .send({ approve: true })
      .expect(201);

    const q = await prisma.quote.findUnique({ where: { id: 'q_qa_big' } });
    expect(q?.status).toBe('approved');
    expect(q?.decidedById).toBe('u_qa_mgr');
    expect(q?.decidedAt).toBeTruthy();
    expect(Number(q?.approvedTotal)).toBe(145000);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'quotes.approved', entityId: 'q_qa_big' },
    });
    expect(audit).toBeTruthy();
  });

  /* --------------- the assertion that makes approval mean something -------- */

  it('editing the amount after approval sends it back for a new decision', async () => {
    // Approved at 145,000. Somebody edits it upward.
    await prisma.quote.update({
      where: { id: 'q_qa_big' },
      data: { grandTotal: 190_000 },
    });

    const gate = await request(server())
      .get('/quotes/q_qa_big/approval')
      .set(auth(repA))
      .expect(200);
    expect(gate.body.cleared).toBe(false);
    expect(gate.body.reason).toMatch(/changed after approval/i);

    const share = await request(server()).post('/quotes/q_qa_big/share').set(auth(repA));
    expect(share.status).toBe(403);
  });

  it('a manager cannot approve a quote they asked for themselves', async () => {
    await makeQuote('q_qa_self', 'QT-QA-3', 150_000);
    await request(server())
      .post('/quotes/q_qa_self/request-approval')
      .set(auth(mgrA))
      .expect(201);
    await request(server())
      .post('/quotes/q_qa_self/decide')
      .set(auth(mgrA))
      .send({ approve: true })
      .expect(403);

    // Unless the tenant deliberately allows it.
    await request(server())
      .put('/quotes/approval/settings')
      .set(auth(hoA))
      .send({ allowSelfApproval: true })
      .expect(200);
    await request(server())
      .post('/quotes/q_qa_self/decide')
      .set(auth(mgrA))
      .send({ approve: true })
      .expect(201);
  });

  it('turning the policy off restores the old behaviour exactly', async () => {
    await request(server())
      .put('/quotes/approval/settings')
      .set(auth(hoA))
      .send({ valueThreshold: null })
      .expect(200);

    const gate = await request(server())
      .get('/quotes/q_qa_big/approval')
      .set(auth(repA))
      .expect(200);
    expect(gate.body.required).toBe(false);
    expect(gate.body.cleared).toBe(true);
  });
});
