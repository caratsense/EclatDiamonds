import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/**
 * Module 9 — stock entry ("All Stores" guard, HUID dedupe, diamond fields) and
 * the "Adjust status" workflow (mandatory reason → status, transfer-lock refusal,
 * transactional bulk). Boots the real app against eclat_preview.
 */
const PASSWORD = 'password123';
const AARAV = 'aarav.mehta@caratsense.in'; // store_manager, Surat
const HO = 'head.office@caratsense.in';
const PRIYA = 'priya.rep@caratsense.in'; // salesperson, Surat
const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra';

let seq = 0;
const sku = () => `ADJ-${Date.now()}-${seq++}`;
// HUID must fit MaxLength(20); keep it short but unique across preview re-runs.
const huidGen = () => `H${(Date.now() % 100000000).toString(36)}${seq++}`;

describe('Stock entry + adjust-status (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const post = (p: string, t: string, b: any) => request(app.getHttpServer()).post(p).set(auth(t)).send(b);
  const patch = (p: string, t: string, b: any) => request(app.getHttpServer()).patch(p).set(auth(t)).send(b);

  const create = (t: string, over: any = {}) =>
    post('/stock', t, { storeId: SURAT, sku: sku(), metal: 'gold_22k', ...over });
  const stock = (id: string) =>
    prisma.stockItem.findUnique({ where: { id }, select: { status: true, diamondPieces: true, huid: true } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = new PrismaClient();
    for (const [k, e] of [['aarav', AARAV], ['ho', HO], ['priya', PRIYA]] as const) {
      const r = await request(app.getHttpServer()).post('/auth/login').send({ email: e, password: PASSWORD });
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
  });
  afterAll(async () => { await prisma?.$disconnect(); await app?.close(); });

  // ── Stock entry ─────────────────────────────────────────────────────────
  it('1. cannot add stock to "All Stores" — must pick a concrete branch', async () => {
    const r = await create(tokens.ho, { storeId: 'all' });
    expect(r.status).toBe(400);
  });

  it('2. add stock to a concrete store with HUID + diamond fields persists them', async () => {
    const huid = huidGen();
    const r = await create(tokens.aarav, { huid, diamondPieces: 12, diamondWeightCt: 1.5, name: 'Ring' });
    expect([200, 201]).toContain(r.status);
    const row = await stock(r.body.id);
    expect(row!.huid).toBe(huid);
    expect(row!.diamondPieces).toBe(12);
  });

  it('3. duplicate HUID is rejected', async () => {
    const huid = huidGen();
    expect([200, 201]).toContain((await create(tokens.aarav, { huid })).status);
    expect((await create(tokens.aarav, { huid })).status).toBe(409);
  });

  it('4. a salesperson cannot add stock', async () => {
    expect((await create(tokens.priya)).status).toBe(403);
  });

  // ── Adjust status ─────────────────────────────────────────────────────────
  it('5. adjust requires a reason', async () => {
    const id = (await create(tokens.aarav)).body.id;
    expect((await patch(`/stock/${id}`, tokens.aarav, {})).status).toBe(400);
  });

  it('6. each reason maps to its status (damaged / reserved manual hold / melting)', async () => {
    const damaged = (await create(tokens.aarav)).body.id;
    await patch(`/stock/${damaged}`, tokens.aarav, { reason: 'damaged' });
    expect((await stock(damaged))!.status).toBe('damaged');

    const held = (await create(tokens.aarav)).body.id;
    await patch(`/stock/${held}`, tokens.aarav, { reason: 'reserved' }); // manual hold now allowed
    expect((await stock(held))!.status).toBe('reserved');

    const melt = (await create(tokens.aarav)).body.id;
    await patch(`/stock/${melt}`, tokens.aarav, { reason: 'melting' });
    expect((await stock(melt))!.status).toBe('melted');
  });

  // ── Bulk ─────────────────────────────────────────────────────────────────
  it('7. bulk-adjust updates all selected pieces transactionally', async () => {
    const ids = [
      (await create(tokens.aarav)).body.id,
      (await create(tokens.aarav)).body.id,
      (await create(tokens.aarav)).body.id,
    ];
    const r = await post('/stock/bulk-adjust', tokens.aarav, { ids, reason: 'damaged' });
    expect([200, 201]).toContain(r.status);
    expect(r.body.updated).toBe(3);
    for (const id of ids) expect((await stock(id))!.status).toBe('damaged');
  });

  it('8. bulk-adjust refuses the whole batch if any piece is transfer-locked (none applied)', async () => {
    const free = (await create(tokens.aarav)).body.id;
    const locked = (await create(tokens.aarav)).body.id;
    // Lock `locked` by attaching it to an approved transfer.
    await prisma.stockTransfer.create({
      data: {
        organisationId: 'org_eclat',
        ref: `ADJLOCK-${Date.now()}-${seq++}`,
        status: 'ho_approved',
        fromStoreId: SURAT,
        toStoreId: MUMBAI,
        requestedById: 'u-sm-aarav',
        items: { create: { stockItemId: locked, sku: 'x', name: 'x' } },
      },
    });
    await prisma.stockItem.update({ where: { id: locked }, data: { status: 'reserved' } });

    const r = await post('/stock/bulk-adjust', tokens.aarav, { ids: [free, locked], reason: 'damaged' });
    expect(r.status).toBe(409);
    expect((await stock(free))!.status).not.toBe('damaged'); // rolled back — nothing applied
  });

  // ── Bulk import ────────────────────────────────────────────────────────────
  it('9. bulk-import creates all rows for a concrete store', async () => {
    const rows = [
      { sku: sku(), metal: 'gold_22k', grossWeight: 10 },
      { sku: sku(), metal: 'gold_18k', huid: huidGen() },
    ];
    const r = await post('/stock/bulk-import', tokens.aarav, { storeId: SURAT, rows });
    expect([200, 201]).toContain(r.status);
    expect(r.body.imported).toBe(2);
    expect(r.body.errors).toHaveLength(0);
  });

  it('10. bulk-import is all-or-nothing: a duplicate HUID in the file imports nothing', async () => {
    const dupe = huidGen();
    const rows = [
      { sku: sku(), metal: 'gold_22k', huid: dupe },
      { sku: sku(), metal: 'gold_22k', huid: dupe }, // duplicate within the file
    ];
    const r = await post('/stock/bulk-import', tokens.aarav, { storeId: SURAT, rows });
    expect([200, 201]).toContain(r.status);
    expect(r.body.imported).toBe(0);
    expect(r.body.errors.length).toBeGreaterThanOrEqual(1);
    // Neither row was written.
    const found = await prisma.stockItem.count({ where: { huid: dupe } });
    expect(found).toBe(0);
  });

  it('11. bulk-import to "All Stores" is rejected', async () => {
    const r = await post('/stock/bulk-import', tokens.ho, {
      storeId: 'all',
      rows: [{ sku: sku(), metal: 'gold_22k' }],
    });
    expect(r.status).toBe(400);
  });
});
