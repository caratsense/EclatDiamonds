import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/prisma/prisma.service';
import { SYNC_STATE_ORGANISATION_SENTINEL, SyncService } from '../src/sync/sync.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SyncService accepted-state monotonicity', () => {
  const prisma = new PrismaService();
  const organisationId = `org_sync_monotonic_${randomUUID()}`;
  const sourceTable = `Monotonic_${randomUUID()}`;
  const service = new SyncService(
    prisma,
    { get: jest.fn() } as any,
    { record: jest.fn() } as any,
    {} as any,
  );

  beforeAll(async () => {
    await prisma.organisation.create({
      data: {
        id: organisationId,
        name: 'Sync monotonicity test tenant',
        slug: `sync-monotonic-${randomUUID()}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.syncState.deleteMany({ where: { organisationId } });
    await prisma.organisation.deleteMany({ where: { id: organisationId } });
    await prisma.$disconnect();
  });

  const record = (
    tx: Prisma.TransactionClient,
    received: number,
    watermark: string,
  ): Promise<void> =>
    (service as any).recordAcceptedSyncState(
      tx,
      organisationId,
      'raw',
      sourceTable,
      received,
      {
        entity: `raw:${sourceTable}`,
        received,
        upserted: received,
        skipped: 0,
        watermark,
      },
    );

  it('retains the newer watermark/run receipt when an older transaction commits last', async () => {
    const olderStarted = deferred();
    const releaseOlder = deferred();
    const olderWatermark = '2026-09-08T09:00:00.000Z';
    const newerWatermark = '2026-09-08T11:00:00.000Z';

    const older = prisma.$transaction(async (tx) => {
      // Establish this transaction's PostgreSQL timestamp before the newer run.
      await tx.$queryRaw(Prisma.sql`SELECT CURRENT_TIMESTAMP`);
      olderStarted.resolve();
      await releaseOlder.promise;
      await record(tx, 2, olderWatermark);
    });

    await olderStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await prisma.$transaction((tx) => record(tx, 3, newerWatermark));
    const afterNewer = await prisma.syncState.findUniqueOrThrow({
      where: {
        organisationId_sourceTable_storeId: {
          organisationId,
          sourceTable,
          storeId: SYNC_STATE_ORGANISATION_SENTINEL,
        },
      },
    });

    releaseOlder.resolve();
    await older;

    const finalState = await prisma.syncState.findUniqueOrThrow({
      where: {
        organisationId_sourceTable_storeId: {
          organisationId,
          sourceTable,
          storeId: SYNC_STATE_ORGANISATION_SENTINEL,
        },
      },
    });
    expect(finalState.lastUpdatedAt?.toISOString()).toBe(newerWatermark);
    expect(finalState.lastRunAt?.getTime()).toBe(afterNewer.lastRunAt?.getTime());
    expect(finalState.rowsSynced).toBe(3);
  });
});
