import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Step 2 — TENANT ISOLATION HARDENING, PART 3.5/3.6 (loyalty + ticketing).
 *
 * Audit §L-H5 / §L-H6: loyalty & ticketing `scopedWhere` OR'd in a bare
 * `{ storeId: null }` branch with NO organisation predicate, so a tenant could
 * read/mutate every OTHER tenant's company-wide (HO-level) referral codes and
 * tickets — and HO could draw down another org's company-wide referral balance.
 *
 * Org A = the seeded "Eclat" organisation (org_eclat), HO head.office@caratsense.in.
 * We stand up a separate Org B with a company-wide (storeId:null) referral code +
 * referral, and BOTH a store-level and a company-wide ticket, all tagged ISO-LOY,
 * then prove Org A HO can neither see nor mutate any of them, while Org B HO can.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in'; // seeded Eclat head office (org_eclat)

const ORG = 'org_iso_loy';
const STORE = 'store_iso_loy';
const SLUG = 'iso-loy';
const B_HO_EMAIL = 'ho.iso-loy@test.local';

// Org-B sentinels — must NEVER appear in / be mutable from an Org-A response.
const S = {
  code: 'ISO-LOY-CODE',
  referrer: 'ISO-LOY Referrer',
  referee: 'ISO-LOY Referee',
  ticketStoreRef: 'ISO-LOY-TKT-STORE',
  ticketHoRef: 'ISO-LOY-TKT-HO',
  ticketHoSubject: 'ISO-LOY company-wide ticket',
};
const START_BALANCE = 1000;

describe('Organisation isolation — loyalty + ticketing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  // ids resolved after seeding
  let codeId = '';
  let hoTicketId = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) =>
    request(app.getHttpServer()).get(path).set(auth(t));
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await teardown(prisma);
    // Loyalty and ticketing are jewellery-pack modules; a tenant with no
    // industry is refused them by the entitlement guard, as it should be.
    await prisma.organisation.create({
      data: { id: ORG, name: 'ISO Loyalty Org', slug: SLUG, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({ data: { id: STORE, name: 'ISO-LOY Store', city: 'Testville', organisationId: ORG } });
    await prisma.user.create({
      data: { email: B_HO_EMAIL, name: 'HO ISO-LOY', role: 'head_office', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: ORG },
    });

    // Company-wide (storeId:null) referral code + one referral, with a non-zero balance.
    const code = await prisma.referralCode.create({
      data: {
        organisationId: ORG,
        code: S.code,
        referrerName: S.referrer,
        storeId: null,
        commissionBalance: START_BALANCE,
        uses: 1,
      },
    });
    codeId = code.id;
    await prisma.referral.create({
      data: {
        codeId: code.id,
        refereeName: S.referee,
        storeId: null,
        billAmount: 20000,
        commissionAmount: START_BALANCE,
      },
    });

    // A store-level ticket AND a company-wide (storeId:null) HO-level ticket.
    await prisma.ticket.create({
      data: { organisationId: ORG, ref: S.ticketStoreRef, storeId: STORE, subject: 'ISO-LOY store ticket', category: 'maintenance' },
    });
    const hoTicket = await prisma.ticket.create({
      data: { organisationId: ORG, ref: S.ticketHoRef, storeId: null, subject: S.ticketHoSubject, category: 'it' },
    });
    hoTicketId = hoTicket.id;

    tokens.aHo = await login(A_HO);
    tokens.bHo = await login(B_HO_EMAIL);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  // ---- Org A must NOT see Org B's company-wide loyalty rows -------------------
  it('A head office referral-codes listing excludes the Org-B company-wide code', async () => {
    const r = await get('/loyalty/referral-codes', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(S.code);
    expect(JSON.stringify(r.body)).not.toContain(S.referrer);
  });

  it('A head office referrals listing excludes the Org-B company-wide referral', async () => {
    const r = await get('/loyalty/referrals', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(S.referee);
  });

  it('A head office CANNOT pay out the Org-B company-wide code; balance is untouched', async () => {
    const r = await request(app.getHttpServer())
      .post(`/loyalty/referral-codes/${codeId}/payout`)
      .set(auth(tokens.aHo))
      .send({ amount: 100, type: 'cashout' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.referralCode.findUnique({ where: { id: codeId } });
    expect(Number(after!.commissionBalance)).toBe(START_BALANCE);
  });

  // ---- Org A must NOT see or mutate Org B's company-wide ticket ---------------
  it('A head office ticket list excludes the Org-B company-wide ticket', async () => {
    const r = await get('/tickets', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(S.ticketHoRef);
    expect(JSON.stringify(r.body)).not.toContain(S.ticketStoreRef);
  });

  it('A head office cannot GET the Org-B company-wide ticket', async () => {
    const r = await get(`/tickets/${hoTicketId}`, tokens.aHo);
    expect([403, 404]).toContain(r.status);
  });

  it('A head office cannot update / close / message the Org-B company-wide ticket', async () => {
    const upd = await request(app.getHttpServer())
      .patch(`/tickets/${hoTicketId}`)
      .set(auth(tokens.aHo))
      .send({ priority: 'high' });
    expect([403, 404]).toContain(upd.status);

    const close = await request(app.getHttpServer())
      .patch(`/tickets/${hoTicketId}/close`)
      .set(auth(tokens.aHo))
      .send({});
    expect([403, 404]).toContain(close.status);

    const msg = await request(app.getHttpServer())
      .post(`/tickets/${hoTicketId}/messages`)
      .set(auth(tokens.aHo))
      .send({ body: 'ISO-LOY intrusion attempt' });
    expect([403, 404]).toContain(msg.status);

    // The ticket is unchanged: still open, no injected message.
    const t = await prisma.ticket.findUnique({ where: { id: hoTicketId }, include: { messages: true } });
    expect(t!.status).toBe('open');
    expect(t!.messages.length).toBe(0);
  });

  // ---- Legitimate same-org access (Org B HO sees its own rows) ----------------
  it('B head office sees its own company-wide referral code and ticket', async () => {
    const codes = await get('/loyalty/referral-codes', tokens.bHo);
    expect(codes.status).toBe(200);
    expect(JSON.stringify(codes.body)).toContain(S.code);

    const tickets = await get('/tickets', tokens.bHo);
    expect(tickets.status).toBe(200);
    expect(JSON.stringify(tickets.body)).toContain(S.ticketHoRef);

    const one = await get(`/tickets/${hoTicketId}`, tokens.bHo);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).toContain(S.ticketHoSubject);
  });
});

async function teardown(prisma: PrismaService) {
  // FK order: payouts/referrals under codes; messages under tickets; then codes,
  // tickets, users, store, org (Organisation FK is onDelete: RESTRICT).
  await prisma.referralPayout.deleteMany({ where: { code: { organisationId: ORG } } });
  await prisma.referral.deleteMany({ where: { code: { organisationId: ORG } } });
  await prisma.referralCode.deleteMany({ where: { organisationId: ORG } });
  await prisma.ticketMessage.deleteMany({ where: { ticket: { organisationId: ORG } } });
  await prisma.ticket.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: ORG } } });
  // AuditLog.actorId -> User is onDelete: RESTRICT; clear org-B audit rows (from the
  // spec's own Org-B HO mutations) before the users they reference.
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { slug: SLUG } });
}
