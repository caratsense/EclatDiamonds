import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Quote approval is GONE (client, 13 Oct: "a quotation once created is
 * created — no approval from anybody").
 *
 * The properties pinned here:
 *
 *  1. QUOTES ARE NEVER HELD. Whatever the amount, whatever a stale settings row
 *     or DiscountLimit says, the gate answers cleared and every door is open —
 *     including for the salesperson who raised it.
 *
 *  2. THE OLD ENDPOINTS DO NOT CRASH AN OLD SCREEN. Reads report the feature as
 *     off (settings disabled, pending empty, gate cleared); writes answer 410
 *     with the reason. Role guards still apply before the 410.
 *
 *  3. EDITING NEVER FLIPS STATUS FOR APPROVAL REASONS, and a quote left in a
 *     legacy approval status is not held by it.
 *
 *  4. THE HISTORY STAYS READABLE: past decision columns are untouched.
 *
 *  5. Deleting a quote is still managers-and-above, and an accepted quote still
 *     cannot be deleted (unchanged rules, re-pinned after the rework).
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

describe('Quote approval removed (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoA: string;
  let mgrA: string;
  let repA: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A quote big enough to have tripped the old threshold, owned by the rep. */
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

    // A tenant that HAD chosen a threshold before 13 Oct. It must hold nothing.
    await prisma.quoteApprovalSettings.create({
      data: { organisationId: A.org, valueThreshold: 100_000, allowSelfApproval: false },
    });

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

  it('a quote over the old threshold is never held: the gate is cleared for everyone', async () => {
    const q = await makeQuote('q_qa_big', 'QT-QA-2', 145_000);
    const gate = await request(server()).get(`/quotes/${q}/approval`).set(auth(repA)).expect(200);
    expect(gate.body).toMatchObject({ required: false, cleared: true, reason: null, reasons: [] });
  });

  it('every door is open to the salesperson who raised it: text, and the PDF with no DRAFT stamp', async () => {
    const share = await request(server()).post('/quotes/q_qa_big/share').set(auth(repA));
    expect(share.status).toBe(201);

    for (const t of [repA, mgrA, hoA]) {
      const pdf = await request(server())
        .get('/quotes/q_qa_big/pdf')
        .set(auth(t))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      // No draft copy exists any more: there is nothing to await.
      expect(pdf.headers['content-disposition']).toContain('-r1.pdf');
      expect(pdf.headers['content-disposition']).not.toContain('-draft');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('the settings read as switched off, whatever the stored row says', async () => {
    const res = await request(server()).get('/quotes/approval/settings').set(auth(mgrA)).expect(200);
    expect(res.body).toMatchObject({ valueThreshold: null, allowSelfApproval: false });
  });

  it('writing the policy is gone (410) — and still role-guarded before that', async () => {
    await request(server())
      .put('/quotes/approval/settings')
      .set(auth(repA))
      .send({ valueThreshold: 100_000 })
      .expect(403);
    const gone = await request(server())
      .put('/quotes/approval/settings')
      .set(auth(hoA))
      .send({ valueThreshold: 100_000 });
    expect(gone.status).toBe(410);
    expect(JSON.stringify(gone.body)).toMatch(/no approval from anybody/i);
  });

  it('nobody asks and nobody decides: quotes are never held', async () => {
    // The manager's own large quote - the case the old gate existed for.
    await makeQuote('q_qa_self', 'QT-QA-3', 150_000);
    await prisma.quote.update({ where: { id: 'q_qa_self' }, data: { assignedRepId: 'u_qa_mgr' } });
    const gate = await request(server()).get('/quotes/q_qa_self/approval').set(auth(mgrA)).expect(200);
    expect(gate.body.cleared).toBe(true);

    expect((await request(server()).post('/quotes/q_qa_big/request-approval').set(auth(repA))).status).toBe(410);
    expect(
      (await request(server()).post('/quotes/q_qa_self/decide').set(auth(mgrA)).send({ approve: true })).status,
    ).toBe(410);
    // A salesperson still cannot reach the decide route at all.
    expect(
      (await request(server()).post('/quotes/q_qa_big/decide').set(auth(repA)).send({ approve: true })).status,
    ).toBe(403);

    // Nothing was flipped by the attempts.
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: 'q_qa_big' } });
    expect(q.status).toBe('draft');
    expect(q.requestedById).toBeNull();
    expect(q.decidedById).toBeNull();
  });

  it('the pending list is empty, even with a quote stuck in a legacy approval status', async () => {
    await makeQuote('q_qa_legacy', 'QT-QA-LEG', 200_000);
    await prisma.quote.update({
      where: { id: 'q_qa_legacy' },
      data: { status: 'pending_approval', requestedById: 'u_qa_rep', requestedAt: new Date() },
    });
    const res = await request(server()).get('/quotes/approval/pending').set(auth(mgrA)).expect(200);
    expect(res.body).toEqual([]);

    // And the legacy status holds nothing.
    const gate = await request(server()).get('/quotes/q_qa_legacy/approval').set(auth(repA)).expect(200);
    expect(gate.body.cleared).toBe(true);
    await request(server()).post('/quotes/q_qa_legacy/share').set(auth(repA)).expect(201);
  });

  it('a past decision stays readable on the quote after the rework', async () => {
    const decidedAt = new Date('2026-10-01T10:00:00Z');
    await makeQuote('q_qa_hist', 'QT-QA-HIST', 180_000);
    await prisma.quote.update({
      where: { id: 'q_qa_hist' },
      data: {
        status: 'approved', decidedById: 'u_qa_mgr', decidedAt, approvedTotal: 180_000,
        approvedRevision: 1, approvalSnapshot: { total: 180000, discountPercent: 0, discountAmount: 0, revision: 1, reasons: [] },
      },
    });
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: 'q_qa_hist' } });
    expect(q.decidedById).toBe('u_qa_mgr');
    expect(Number(q.approvedTotal)).toBe(180000);
    expect(q.approvalSnapshot).toMatchObject({ total: 180000 });
    // And it is simply a quote now: cleared like any other.
    const gate = await request(server()).get('/quotes/q_qa_hist/approval').set(auth(repA)).expect(200);
    expect(gate.body).toMatchObject({ required: false, cleared: true });
  });

  it('a manager deletes a quote; a salesperson and an accepted quote are refused', async () => {
    await makeQuote('q_qa_del', 'QT-QA-DEL', 10_000);

    // The floor role cannot erase a priced offer.
    await request(server()).delete('/quotes/q_qa_del').set(auth(repA)).expect(403);

    // A manager can, and the row is gone whole (lines cascade).
    await request(server()).delete('/quotes/q_qa_del').set(auth(mgrA)).expect(200);
    expect(await prisma.quote.findUnique({ where: { id: 'q_qa_del' } })).toBeNull();

    // The quote that became an order is the record that must survive.
    await makeQuote('q_qa_del2', 'QT-QA-DEL2', 10_000);
    await prisma.quote.update({ where: { id: 'q_qa_del2' }, data: { status: 'accepted' } });
    const refused = await request(server()).delete('/quotes/q_qa_del2').set(auth(hoA));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/order/i);
    await prisma.quote.delete({ where: { id: 'q_qa_del2' } });
  });
});
