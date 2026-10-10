import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/**
 * Module 9 — manual reorder requests (client 9 Oct 2026, item 16).
 *
 * "Reorder" here is a MERCHANDISING ask — a branch wants N more pieces of a
 * design that sells, even when its current piece sits unsold at another branch
 * — routed through the existing SpecialRequest ladder (kind `reorder`), not a
 * reorder-point/low-stock alert.
 *
 * Covers: raising (salesperson), payload validation (design + quantity are the
 * request), approver routing (store_manager floor; one-rank-above for a
 * manager's own ask), the decision record, and the gates (a salesperson cannot
 * decide; deciding is refused below the required role).
 */
const PASSWORD = 'password123';
const PRIYA = 'priya.rep@caratsense.in'; // salesperson, Surat
const AARAV = 'aarav.mehta@caratsense.in'; // store_manager, Surat
const HO = 'head.office@caratsense.in';
const SURAT = 'surat-main';

describe('Reorder requests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let productId: string;
  let productSku: string;
  const tokens: Record<string, string> = {};

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (email: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(path).set(auth(token)).send(body);
  const patch = (path: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).patch(path).set(auth(token)).send(body);
  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set(auth(token));

  /** Raise a reorder as `token`; returns the created request body. */
  const raise = async (token: string, qty = 3, extra: Record<string, unknown> = {}) => {
    const r = await post('/requests', token, {
      storeId: SURAT,
      kind: 'reorder',
      title: 'Reorder test design',
      productId,
      quantity: qty,
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = new PrismaClient();
    for (const [k, e] of [['priya', PRIYA], ['aarav', AARAV], ['ho', HO]] as const) {
      const r = await login(e);
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
    // A design of our own, so the spec does not depend on demo catalogue rows.
    productSku = `RO-${Date.now()}`;
    const product = await prisma.product.create({
      data: {
        organisationId: 'org_eclat',
        storeId: SURAT,
        sku: productSku,
        name: 'Reorder Test Ring',
        metal: 'gold_18k',
        styleNumber: 'RO-STYLE-1',
      },
      select: { id: true },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('1. a salesperson raises a reorder for a design with qty 3; the payload is echoed back', async () => {
    const body = await raise(tokens.priya, 3);
    expect(body.kind).toBe('reorder');
    expect(body.status).toBe('pending');
    expect(body.productId).toBe(productId);
    expect(body.quantity).toBe(3);
    expect(body.product).toMatchObject({
      sku: productSku,
      name: 'Reorder Test Ring',
      styleNumber: 'RO-STYLE-1',
    });
    // Merchandising is the store manager's call.
    expect(body.requiredRole).toBe('store_manager');
  });

  it('2. a reorder without its design or count — or against a ghost design — is refused', async () => {
    const missing = await post('/requests', tokens.priya, {
      storeId: SURAT, kind: 'reorder', title: 'Reorder with no design',
    });
    expect(missing.status).toBe(400);

    const zero = await post('/requests', tokens.priya, {
      storeId: SURAT, kind: 'reorder', title: 'Reorder of nothing', productId, quantity: 0,
    });
    expect(zero.status).toBe(400);

    const ghost = await post('/requests', tokens.priya, {
      storeId: SURAT, kind: 'reorder', title: 'Reorder of a ghost', productId: 'no-such-design', quantity: 2,
    });
    expect(ghost.status).toBe(400);
  });

  it('3. the manager sees it in their inbox and approves; the decision is recorded', async () => {
    const req = await raise(tokens.priya, 3);

    // It lands where the manager already looks: their approver inbox.
    const inbox = await get('/requests?scope=inbox&kind=reorder', tokens.aarav);
    expect(inbox.status).toBe(200);
    const mine = inbox.body.find((r: { id: string }) => r.id === req.id);
    expect(mine).toBeDefined();
    expect(mine.canDecide).toBe(true);
    expect(mine.quantity).toBe(3);

    const decided = await patch(`/requests/${req.id}/decide`, tokens.aarav, {
      status: 'approved',
      note: 'Order two from the karigar, pull one from Mumbai',
    });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe('approved');
    expect(decided.body.decidedBy).toBe('Aarav Mehta');
    expect(decided.body.decidedAt).toBeTruthy();
    expect(decided.body.decisionNote).toContain('karigar');

    // The transition is recorded on the row itself, not just the response.
    const row = await prisma.specialRequest.findUnique({ where: { id: req.id } });
    expect(row?.status).toBe('approved');
    expect(row?.decidedRole).toBe('store_manager');
    expect(row?.quantity).toBe(3);

    // A terminal request cannot be re-decided (assertUndecided → 400).
    const again = await patch(`/requests/${req.id}/decide`, tokens.aarav, { status: 'rejected' });
    expect(again.status).toBe(400);
  });

  it('4. a salesperson cannot approve a reorder — not even somebody else’s', async () => {
    const req = await raise(tokens.aarav, 2); // the manager's own ask
    const r = await patch(`/requests/${req.id}/decide`, tokens.priya, { status: 'approved' });
    expect(r.status).toBe(403);
  });

  it('5. a manager’s own reorder climbs to head office; the manager cannot decide it', async () => {
    const req = await raise(tokens.aarav, 5);
    // One rank above the requester: store_manager → head_office.
    expect(req.requiredRole).toBe('head_office');

    const self = await patch(`/requests/${req.id}/decide`, tokens.aarav, { status: 'approved' });
    expect(self.status).toBe(403);

    const ho = await patch(`/requests/${req.id}/decide`, tokens.ho, { status: 'rejected', note: 'Dead stock risk' });
    expect(ho.status).toBe(200);
    expect(ho.body.status).toBe('rejected');
  });
});
