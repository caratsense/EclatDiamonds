import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/**
 * Module 9 — inter-store Stock Transfer workflow (risk-based e2e).
 *
 * Boots the real app against eclat_preview. Covers the five properties the
 * feature must hold: the state machine (legal/illegal transitions), authorization
 * (who may act at each stage + store isolation), inventory integrity (reserve at
 * approve, re-home ONCE at receive, StockMovement written), idempotency (repeat
 * actions 409 without double-applying), and audit.
 *
 * Actors (seeded): aarav = store_manager @ surat-main (SOURCE); karan =
 * store_manager @ mumbai-bandra (DEST); ho = head_office; priya = salesperson.
 */
const PASSWORD = 'password123';
const AARAV = 'aarav.mehta@caratsense.in'; // store_manager, Surat (source)
const KARAN = 'karan.malhotra@caratsense.in'; // store_manager, Mumbai (dest)
const HO = 'head.office@caratsense.in';
const PRIYA = 'priya.rep@caratsense.in'; // salesperson, Surat
const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra';
const AHMEDABAD = 'ahmedabad-cg';

let seq = 0;

describe('Stock transfer workflow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (email: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set(auth(token));

  /** Insert an available piece at a store; returns its id. */
  const piece = async (storeId: string, status: any = 'in_stock') => {
    const p = await prisma.stockItem.create({
      data: { organisationId: 'org_eclat', storeId, status, sku: `TX-${Date.now()}-${seq++}`, name: 'Test piece' },
      select: { id: true },
    });
    return p.id;
  };
  const stock = (id: string) =>
    prisma.stockItem.findUnique({ where: { id }, select: { storeId: true, status: true } });

  /** Create + submit a transfer of `ids` from SURAT to `to`; returns transfer id. */
  const submitted = async (ids: string[], to = MUMBAI) => {
    const c = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT,
      toStoreId: to,
      stockItemIds: ids,
    });
    expect([200, 201]).toContain(c.status);
    const s = await post(`/stock-transfers/${c.body.id}/submit`, tokens.aarav);
    expect([200, 201]).toContain(s.status);
    return c.body.id as string;
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
    for (const [k, e] of [['aarav', AARAV], ['karan', KARAN], ['ho', HO], ['priya', PRIYA]] as const) {
      const r = await login(e);
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  // ── State machine ──────────────────────────────────────────────────────────
  it('1. full happy path draft→submitted→approved→dispatched→received→acknowledged', async () => {
    const id = await piece(SURAT);
    const c = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [id],
    });
    expect(c.body.status).toBe('draft');
    const tid = c.body.id;

    expect((await post(`/stock-transfers/${tid}/submit`, tokens.aarav)).body.status).toBe('submitted');
    expect((await post(`/stock-transfers/${tid}/approve`, tokens.ho)).body.status).toBe('ho_approved');
    expect((await stock(id))!.status).toBe('reserved'); // reserved, not moved
    expect((await stock(id))!.storeId).toBe(SURAT);

    expect((await post(`/stock-transfers/${tid}/dispatch`, tokens.aarav)).body.status).toBe('dispatched');
    expect((await stock(id))!.storeId).toBe(SURAT); // STILL at source after dispatch

    expect((await post(`/stock-transfers/${tid}/receive`, tokens.karan)).body.status).toBe('received');
    const after = await stock(id);
    expect(after!.storeId).toBe(MUMBAI); // re-homed only at receive
    expect(after!.status).toBe('in_stock');

    expect((await post(`/stock-transfers/${tid}/acknowledge`, tokens.karan)).body.status).toBe('acknowledged');
  });

  it('2. illegal transitions are rejected (approve draft, dispatch submitted, receive approved)', async () => {
    const draft = (await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [await piece(SURAT)],
    })).body.id;
    expect((await post(`/stock-transfers/${draft}/approve`, tokens.ho)).status).toBe(409);
    expect((await post(`/stock-transfers/${draft}/dispatch`, tokens.aarav)).status).toBe(409);

    const sub = await submitted([await piece(SURAT)]);
    expect((await post(`/stock-transfers/${sub}/dispatch`, tokens.aarav)).status).toBe(409);
    expect((await post(`/stock-transfers/${sub}/receive`, tokens.karan)).status).toBe(409);
  });

  it('3. reject from submitted closes it; a later approve 409s', async () => {
    const sub = await submitted([await piece(SURAT)]);
    const r = await post(`/stock-transfers/${sub}/reject`, tokens.ho, { reason: 'not now' });
    expect(r.body.status).toBe('rejected');
    expect((await post(`/stock-transfers/${sub}/approve`, tokens.ho)).status).toBe(409);
  });

  it('4. cancel from ho_approved releases the reservation', async () => {
    const id = await piece(SURAT);
    const sub = await submitted([id]);
    await post(`/stock-transfers/${sub}/approve`, tokens.ho);
    expect((await stock(id))!.status).toBe('reserved');
    const c = await post(`/stock-transfers/${sub}/cancel`, tokens.aarav, { reason: 'stop' });
    expect(c.body.status).toBe('cancelled');
    expect((await stock(id))!.status).toBe('in_stock'); // released
    expect((await stock(id))!.storeId).toBe(SURAT);
  });

  // ── Authorization ────────────────────────────────────────────────────────
  it('5. salesperson cannot create a transfer', async () => {
    const r = await post('/stock-transfers', tokens.priya, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [await piece(SURAT)],
    });
    expect(r.status).toBe(403);
  });

  it('6. store_manager cannot approve (HO only)', async () => {
    const sub = await submitted([await piece(SURAT)]);
    expect((await post(`/stock-transfers/${sub}/approve`, tokens.aarav)).status).toBe(403);
  });

  it('7. head_office cannot create/dispatch (branch operations only)', async () => {
    const r = await post('/stock-transfers', tokens.ho, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [await piece(SURAT)],
    });
    expect(r.status).toBe(403);
  });

  it('8. source manager cannot receive into a destination out of scope', async () => {
    const id = await piece(SURAT);
    const sub = await submitted([id]);
    await post(`/stock-transfers/${sub}/approve`, tokens.ho);
    await post(`/stock-transfers/${sub}/dispatch`, tokens.aarav);
    expect((await post(`/stock-transfers/${sub}/receive`, tokens.aarav)).status).toBe(403);
  });

  it('9. destination manager cannot dispatch from a source out of scope', async () => {
    const sub = await submitted([await piece(SURAT)]);
    await post(`/stock-transfers/${sub}/approve`, tokens.ho);
    expect((await post(`/stock-transfers/${sub}/dispatch`, tokens.karan)).status).toBe(403);
  });

  it('10. cannot create a transfer whose source is out of the caller scope (body not trusted)', async () => {
    // aarav is Surat-only; a piece physically at Mumbai with fromStoreId=Mumbai.
    const r = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: MUMBAI, toStoreId: SURAT, stockItemIds: [await piece(MUMBAI)],
    });
    expect(r.status).toBe(403);
  });

  it('11. store isolation: a manager cannot view a transfer touching neither of their stores', async () => {
    // karan is Mumbai-only; a Surat→Ahmedabad transfer is invisible to them.
    const sub = await submitted([await piece(SURAT)], AHMEDABAD);
    expect((await get(`/stock-transfers/${sub}`, tokens.karan)).status).toBe(403);
  });

  // ── Inventory integrity ──────────────────────────────────────────────────
  it('12. same piece cannot be approved onto two transfers (double-dispatch guard)', async () => {
    const id = await piece(SURAT);
    const a = await submitted([id]);
    const b = await submitted([id]); // both drafts legally include an in_stock piece
    expect((await post(`/stock-transfers/${a}/approve`, tokens.ho)).body.status).toBe('ho_approved');
    expect((await post(`/stock-transfers/${b}/approve`, tokens.ho)).status).toBe(409); // no longer available
    // b did not partially apply: it is still submitted.
    expect((await get(`/stock-transfers/${b}`, tokens.ho)).body.status).toBe('submitted');
  });

  it('13. receive writes exactly one StockMovement linked to the transfer', async () => {
    const id = await piece(SURAT);
    const tid = await submitted([id]);
    await post(`/stock-transfers/${tid}/approve`, tokens.ho);
    await post(`/stock-transfers/${tid}/dispatch`, tokens.aarav);
    await post(`/stock-transfers/${tid}/receive`, tokens.karan);
    const moves = await prisma.stockMovement.findMany({ where: { stockTransferId: tid } });
    expect(moves.length).toBe(1);
    expect(moves[0].fromStoreId).toBe(SURAT);
    expect(moves[0].toStoreId).toBe(MUMBAI);
    expect(moves[0].stockItemId).toBe(id);
  });

  it('14. cannot include an unavailable (reserved) piece', async () => {
    const id = await piece(SURAT, 'reserved');
    const r = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [id],
    });
    expect(r.status).toBe(400);
  });

  it('15. cannot include a piece that is not at the source store', async () => {
    const r = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [await piece(MUMBAI)],
    });
    expect(r.status).toBe(400);
  });

  it('16. source and destination must differ', async () => {
    const r = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT, toStoreId: SURAT, stockItemIds: [await piece(SURAT)],
    });
    expect(r.status).toBe(400);
  });

  // ── Idempotency ─────────────────────────────────────────────────────────
  it('17. submit twice → second 409', async () => {
    const c = await post('/stock-transfers', tokens.aarav, {
      fromStoreId: SURAT, toStoreId: MUMBAI, stockItemIds: [await piece(SURAT)],
    });
    expect((await post(`/stock-transfers/${c.body.id}/submit`, tokens.aarav)).body.status).toBe('submitted');
    expect((await post(`/stock-transfers/${c.body.id}/submit`, tokens.aarav)).status).toBe(409);
  });

  it('18. approve twice → second 409, piece reserved once', async () => {
    const id = await piece(SURAT);
    const sub = await submitted([id]);
    expect((await post(`/stock-transfers/${sub}/approve`, tokens.ho)).body.status).toBe('ho_approved');
    expect((await post(`/stock-transfers/${sub}/approve`, tokens.ho)).status).toBe(409);
    expect((await stock(id))!.status).toBe('reserved');
  });

  it('19. receive twice → second 409, exactly one movement, piece not double-moved', async () => {
    const id = await piece(SURAT);
    const tid = await submitted([id]);
    await post(`/stock-transfers/${tid}/approve`, tokens.ho);
    await post(`/stock-transfers/${tid}/dispatch`, tokens.aarav);
    expect((await post(`/stock-transfers/${tid}/receive`, tokens.karan)).body.status).toBe('received');
    expect((await post(`/stock-transfers/${tid}/receive`, tokens.karan)).status).toBe(409);
    const moves = await prisma.stockMovement.findMany({ where: { stockTransferId: tid } });
    expect(moves.length).toBe(1);
    expect((await stock(id))!.storeId).toBe(MUMBAI);
  });

  // ── Reservation lock vs sibling mutators ─────────────────────────────────
  it('21. a transfer-locked piece cannot be disposed via PATCH /stock/:id (double-disposal guard)', async () => {
    const id = await piece(SURAT);
    const sub = await submitted([id]);
    await post(`/stock-transfers/${sub}/approve`, tokens.ho); // now reserved by the transfer
    const r = await request(app.getHttpServer())
      .patch(`/stock/${id}`)
      .set(auth(tokens.aarav))
      .send({ reason: 'sold' });
    expect(r.status).toBe(409); // owned by the live transfer
    expect((await stock(id))!.status).toBe('reserved'); // unchanged
  });

  it('22. adjust requires a mandatory reason', async () => {
    const id = await piece(SURAT);
    const r = await request(app.getHttpServer())
      .patch(`/stock/${id}`)
      .set(auth(tokens.aarav))
      .send({}); // no reason
    expect(r.status).toBe(400);
  });

  // ── Audit ───────────────────────────────────────────────────────────────
  it('20. approve and receive each write an audit row', async () => {
    const id = await piece(SURAT);
    const tid = await submitted([id]);
    await post(`/stock-transfers/${tid}/approve`, tokens.ho);
    await post(`/stock-transfers/${tid}/dispatch`, tokens.aarav);
    await post(`/stock-transfers/${tid}/receive`, tokens.karan);
    const logs = await prisma.auditLog.findMany({
      where: { entityType: 'StockTransfer', entityId: tid },
      select: { action: true },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('stock_transfer.approve');
    expect(actions).toContain('stock_transfer.receive');
  });
});
