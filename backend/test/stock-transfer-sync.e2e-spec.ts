import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/**
 * Module 9 — source-of-truth split between the legacy Gati stock sync and an
 * Eclat-controlled stock transfer.
 *
 * Business rule: Gati owns a piece until it enters an Eclat transfer. Once that
 * transfer reserves the piece (ho_approved/dispatched) or moves it
 * (received/acknowledged), ECLAT is authoritative for the piece's store/location
 * and status — a later Gati sync must NOT overwrite those two fields, but must
 * keep syncing every other (Gati-owned) field. A rejected/cancelled transfer
 * hands ownership back to Gati.
 *
 * The transfer *state* is set up directly via Prisma here (the transfer workflow
 * itself is covered by stock-transfer.e2e-spec.ts); this suite isolates what the
 * SYNC does when it meets a piece in each state. Branch resolution is made
 * deterministic with a throwaway source store carrying a known legacyId, fed to
 * the sync via the `EclatBranchId` column the resolver checks first.
 */
const PASSWORD = 'password123';
const HO = 'head.office@caratsense.in';
const DEST = 'mumbai-bandra'; // where Eclat puts a received piece
const SRC_STORE_ID = 'txsync-src-store';
const SRC_LEGACY = 'LEG-TXSYNC-SRC'; // sync records resolve here via EclatBranchId

let seq = 0;
const lid = () => `TXSYNC-${Date.now()}-${seq++}`;

describe('Stock transfer × legacy sync source-of-truth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let hoToken: string;

  const syncStock = (records: Record<string, unknown>[]) =>
    request(app.getHttpServer())
      .post('/sync/stock')
      .set({ Authorization: `Bearer ${hoToken}` })
      .send({ records });

  const stock = (id: string) =>
    prisma.stockItem.findUnique({ where: { id }, select: { storeId: true, status: true, name: true } });

  /** A piece with a legacyId (so sync can match it), at `storeId`/`status`. */
  const piece = async (storeId: string, status: any) => {
    const legacyId = lid();
    const p = await prisma.stockItem.create({
      data: { legacyId, storeId, status, sku: legacyId, name: 'orig', tagPrice: '100' },
      select: { id: true, legacyId: true },
    });
    return p;
  };

  /** Attach `stockItemId` to a transfer FROM the throwaway src TO mumbai in `status`. */
  const transferItem = async (stockItemId: string, status: any) => {
    await prisma.stockTransfer.create({
      data: {
        ref: `STX-${Date.now()}-${seq++}`,
        status,
        fromStoreId: SRC_STORE_ID,
        toStoreId: DEST,
        requestedById: 'u-sm-aarav',
        items: { create: { stockItemId, sku: 'x', name: 'x' } },
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
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

    const r = await request(app.getHttpServer()).post('/auth/login').send({ email: HO, password: PASSWORD });
    expect(r.status).toBe(201);
    hoToken = r.body.token;

    // Throwaway source store with a known legacyId so `EclatBranchId` resolves.
    await prisma.store.upsert({
      where: { id: SRC_STORE_ID },
      create: { id: SRC_STORE_ID, name: 'TX Sync Source', city: 'Testville', legacyId: SRC_LEGACY },
      update: { legacyId: SRC_LEGACY },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('1. a RECEIVED piece keeps its Eclat store + status; Gati-owned fields still sync', async () => {
    const p = await piece(DEST, 'in_stock');
    await transferItem(p.id, 'received');
    // Sync says: this piece belongs to SRC and is SOLD, with a new name.
    const res = await syncStock([
      { JewelId: p.legacyId, EclatBranchId: SRC_LEGACY, JewelCode: 'NEWNAME', TagPrice: 999, Status: 'X' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.eclatControlledPreserved).toBeGreaterThanOrEqual(1);
    const after = await stock(p.id);
    expect(after!.storeId).toBe(DEST); // preserved (not reverted to SRC)
    expect(after!.status).toBe('in_stock'); // preserved (not overwritten to sold)
    expect(after!.name).toBe('NEWNAME'); // Gati-owned field still synced
  });

  it('2. an UNTRANSFERRED piece syncs normally (store + status change per Gati)', async () => {
    const p = await piece(DEST, 'in_stock');
    const res = await syncStock([
      { JewelId: p.legacyId, EclatBranchId: SRC_LEGACY, JewelCode: 'CTRL', Status: 'X' },
    ]);
    expect(res.status).toBe(201);
    const after = await stock(p.id);
    expect(after!.storeId).toBe(SRC_STORE_ID); // moved per Gati
    expect(after!.status).toBe('sold'); // changed per Gati
    expect(after!.name).toBe('CTRL');
  });

  it('3. an in-flight RESERVED piece (ho_approved) is not reverted by sync', async () => {
    const p = await piece(SRC_STORE_ID, 'reserved');
    await transferItem(p.id, 'ho_approved');
    const res = await syncStock([
      { JewelId: p.legacyId, EclatBranchId: SRC_LEGACY, JewelCode: 'x', Status: 'A' }, // A → in_stock
    ]);
    expect(res.status).toBe(201);
    const after = await stock(p.id);
    expect(after!.status).toBe('reserved'); // lock preserved, not reset to in_stock
    expect(after!.storeId).toBe(SRC_STORE_ID);
  });

  it('4. a CANCELLED transfer hands ownership back to Gati (piece syncs normally)', async () => {
    const p = await piece(DEST, 'in_stock');
    await transferItem(p.id, 'cancelled');
    const res = await syncStock([
      { JewelId: p.legacyId, EclatBranchId: SRC_LEGACY, JewelCode: 'x', Status: 'X' },
    ]);
    expect(res.status).toBe(201);
    const after = await stock(p.id);
    expect(after!.storeId).toBe(SRC_STORE_ID); // not protected → moved
    expect(after!.status).toBe('sold');
  });

  it('5. repeated sync of a received piece is stable and creates no stock movement', async () => {
    const p = await piece(DEST, 'in_stock');
    await transferItem(p.id, 'received');
    const rec = [{ JewelId: p.legacyId, EclatBranchId: SRC_LEGACY, JewelCode: 'y', Status: 'X' }];
    await syncStock(rec);
    await syncStock(rec);
    await syncStock(rec);
    const after = await stock(p.id);
    expect(after!.storeId).toBe(DEST);
    expect(after!.status).toBe('in_stock');
    // Sync must never write to the transfer ledger.
    const moves = await prisma.stockMovement.count({ where: { stockItemId: p.id } });
    expect(moves).toBe(0);
  });
});
