import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuthUser } from '../src/common/auth-user';
import { GatiIngestionContext, parseGatiRoutingPolicy } from '../src/sync/gati-ingestion.guard';
import { SYNC_STATE_ORGANISATION_SENTINEL, SyncService } from '../src/sync/sync.service';

const PROFILE_HASH = 'a'.repeat(64);
const SOURCE_HASH = 'b'.repeat(64);

type AgentRow = {
  id: string;
  organisationId: string;
  sourceSystem: string;
  sourceInstanceHash: string | null;
  tokenHash: string;
  revokedAt: Date | null;
  config: Record<string, unknown>;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FenceHarness {
  readonly rawWrites: unknown[] = [];
  readonly stateWrites: unknown[] = [];
  readonly stores: Array<{
    id: string;
    organisationId: string;
    legacyId: string | null;
    isAggregate: boolean;
  }> = [];
  readonly lockQueries: string[] = [];
  readonly auditRecord = jest.fn();

  pauseFirstWrite = false;
  firstWriteReached = deferred();
  continueFirstWrite = deferred();
  private lockReleased: ReturnType<typeof deferred> | null = null;

  readonly tx = {
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      this.lockQueries.push(query.strings.join('?'));
      return [
        {
          ...this.agent,
          config: JSON.parse(JSON.stringify(this.agent.config)),
        },
      ];
    }),
    $executeRaw: jest.fn(async (query: Prisma.Sql) => {
      const [, organisationId, sourceTable, storeId, watermark, received] = query.values;
      // Normalise the raw atomic upsert into the old harness shape so the
      // surrounding generation-fence assertions stay implementation-agnostic.
      this.stateWrites.push({
        where: {
          organisationId_sourceTable_storeId: {
            organisationId,
            sourceTable,
            storeId,
          },
        },
        create: { organisationId, sourceTable, storeId, lastUpdatedAt: watermark },
        update: { rowsSynced: received, lastUpdatedAt: watermark },
      });
      return 1;
    }),
    legacyRow: {
      upsert: jest.fn(async (args: unknown) => {
        this.rawWrites.push(args);
        if (this.pauseFirstWrite && this.rawWrites.length === 1) {
          this.firstWriteReached.resolve();
          await this.continueFirstWrite.promise;
        }
        return {};
      }),
    },
    syncState: {
      upsert: jest.fn(async (args: unknown) => {
        this.stateWrites.push(args);
        return {};
      }),
    },
    store: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          this.stores.find(
            (store) =>
              (where.id === undefined || store.id === where.id) &&
              (where.legacyId === undefined || store.legacyId === where.legacyId) &&
              (where.organisationId === undefined || store.organisationId === where.organisationId) &&
              (where.isAggregate === undefined || store.isAggregate === where.isAggregate),
          ) ?? null,
      ),
      count: jest.fn(
        async ({ where }: any) =>
          this.stores.filter(
            (store) =>
              store.organisationId === where.organisationId &&
              !store.isAggregate &&
              (where.legacyId?.not === null ? store.legacyId !== null : true),
          ).length,
      ),
    },
  };

  readonly prisma = {
    withTenant: jest.fn(async <T>(organisationId: string, work: (tx: typeof this.tx) => Promise<T>) => {
      expect(organisationId).toBe(this.agent.organisationId);
      if (this.lockReleased) {
        throw new Error('test harness permits only one active fenced request');
      }
      const released = deferred();
      this.lockReleased = released;
      try {
        return await work(this.tx);
      } finally {
        this.lockReleased = null;
        released.resolve();
      }
    }),
  };

  constructor(readonly agent: AgentRow) {}

  /** A ConnectAgent UPDATE cannot complete while the request holds FOR SHARE. */
  queueHeadOfficeMutation(change: () => void): Promise<void> {
    const lock = this.lockReleased;
    if (!lock) throw new Error('no fenced request is active');
    return lock.promise.then(() => change());
  }

  service(configGet: (key: string) => unknown = () => undefined) {
    return new SyncService(
      this.prisma as any,
      { get: configGet } as any,
      { record: this.auditRecord } as any,
      {} as any,
    );
  }
}

function agent(organisationId = 'org-a', config: Record<string, unknown> = {}): AgentRow {
  return {
    id: `agent-${organisationId}`,
    organisationId,
    sourceSystem: 'gati',
    sourceInstanceHash: SOURCE_HASH,
    tokenHash: `token-${organisationId}`,
    revokedAt: null,
    config: {
      enabled: true,
      expectedProfileHash: PROFILE_HASH,
      expectedSourceInstanceHash: SOURCE_HASH,
      configRevision: `revision-${organisationId}`,
      defaultStoreId: null,
      unattributedMode: 'holding',
      branchColumns: {},
      ...config,
    },
  };
}

function generation(row: AgentRow): GatiIngestionContext {
  return {
    agentId: row.id,
    organisationId: row.organisationId,
    tokenHash: row.tokenHash,
    configRevision: String(row.config.configRevision),
    profileId: 'gati-fence-test',
    profileHash: PROFILE_HASH,
    sourceInstanceHash: SOURCE_HASH,
    routing: parseGatiRoutingPolicy(row.config),
  };
}

function userFor(context: GatiIngestionContext): AuthUser {
  return {
    id: `agent:${context.agentId}`,
    name: 'Gati test agent',
    email: '',
    role: 'head_office',
    organisationId: context.organisationId,
    storeIds: [],
    allStores: true,
    isMachine: true,
    agentId: context.agentId,
    agentTokenHash: context.tokenHash,
    agentConfigRevision: context.configRevision,
    connectorSourceSystem: 'gati',
  };
}

describe('legacy Gati generation fence', () => {
  it.each([
    [
      'token rotation',
      (row: AgentRow) => {
        row.tokenHash = 'rotated-token';
      },
    ],
    [
      'revocation',
      (row: AgentRow) => {
        row.revokedAt = new Date('2026-09-08T12:00:00.000Z');
      },
    ],
    [
      'configuration replacement',
      (row: AgentRow) => {
        row.config = { ...row.config, configRevision: 'replacement-revision' };
      },
    ],
  ])('linearizes a batch before %s and rejects every later stale write', async (_label, mutate) => {
    const row = agent();
    const harness = new FenceHarness(row);
    harness.pauseFirstWrite = true;
    const service = harness.service();
    const request = generation(row);
    const user = userFor(request);
    const records = [
      { _rowKey: '1', _updatedAt: '2026-09-08T10:00:00.000Z' },
      { _rowKey: '2', _updatedAt: '2026-09-08T10:01:00.000Z' },
    ];

    const batch = service.runGatiIngestion(
      user,
      request,
      'raw',
      records.length,
      () => service.syncRaw(row.organisationId, 'BarrierTable', records),
      'BarrierTable',
    );
    await harness.firstWriteReached.promise;

    let mutationCompleted = false;
    const mutation = harness.queueHeadOfficeMutation(() => {
      mutate(row);
      mutationCompleted = true;
    });
    // This is a logical barrier, not a timing assertion: the mutation promise
    // is chained to transaction release and therefore cannot have completed.
    expect(mutationCompleted).toBe(false);

    harness.continueFirstWrite.resolve();
    await expect(batch).resolves.toMatchObject({
      received: 2,
      upserted: 2,
      skipped: 0,
    });
    await mutation;
    expect(mutationCompleted).toBe(true);
    expect(harness.rawWrites).toHaveLength(2);
    expect(harness.lockQueries.join('\n')).toContain('FOR SHARE');

    const writtenBeforeStaleRetry = harness.rawWrites.length;
    await expect(
      service.runGatiIngestion(
        user,
        request,
        'raw',
        1,
        () => service.syncRaw(row.organisationId, 'BarrierTable', [{ _rowKey: 'later' }]),
        'BarrierTable',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.rawWrites).toHaveLength(writtenBeforeStaleRetry);
  });
});

describe('legacy Gati approved tenant routing', () => {
  it('lets two organisations use different defaults and branch columns without consulting env', async () => {
    const cases = [
      {
        organisationId: 'org-clinic',
        defaultStoreId: 'clinic-default',
        branchStoreId: 'clinic-branch',
        column: 'ClinicBranch',
        legacy: 'CL-1',
      },
      {
        organisationId: 'org-factory',
        defaultStoreId: 'factory-default',
        branchStoreId: 'factory-plant',
        column: 'PlantCode',
        legacy: 'PL-9',
      },
    ];

    for (const item of cases) {
      const row = agent(item.organisationId, {
        defaultStoreId: item.defaultStoreId,
        unattributedMode: 'default',
        branchColumns: { parties: [item.column] },
      });
      const harness = new FenceHarness(row);
      harness.stores.push(
        {
          id: item.defaultStoreId,
          organisationId: item.organisationId,
          legacyId: null,
          isAggregate: false,
        },
        {
          id: item.branchStoreId,
          organisationId: item.organisationId,
          legacyId: item.legacy,
          isAggregate: false,
        },
      );
      const configGet = jest.fn(() => {
        throw new Error('process-global routing must not be consulted');
      });
      const service = harness.service(configGet);
      const request = generation(row);
      let resolved: string[] = [];

      await service.runGatiIngestion(userFor(request), request, 'parties', 1, async () => {
        const resolver = await (service as any).branchResolver('parties', item.organisationId);
        resolved = [await resolver.resolveRequired({ [item.column]: item.legacy }), await resolver.resolveRequired({})];
        expect(resolver.report().branchColumns).toEqual([item.column]);
        return {
          entity: 'parties',
          received: 1,
          upserted: 1,
          skipped: 0,
          watermark: null,
        };
      });

      expect(resolved).toEqual([item.branchStoreId, item.defaultStoreId]);
      expect(configGet).not.toHaveBeenCalled();
    }
  });

  it('refuses an approved default store that is foreign to the agent tenant', async () => {
    const row = agent('org-a', {
      defaultStoreId: 'store-owned-by-b',
      unattributedMode: 'default',
    });
    const harness = new FenceHarness(row);
    harness.stores.push({
      id: 'store-owned-by-b',
      organisationId: 'org-b',
      legacyId: null,
      isAggregate: false,
    });
    const service = harness.service();
    const request = generation(row);
    const work = jest.fn();

    await expect(service.runGatiIngestion(userFor(request), request, 'parties', 1, work)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects malformed/unknown branch-column policy at the ingestion edge', () => {
    expect(() =>
      parseGatiRoutingPolicy({
        branchColumns: { parties: ['BranchNo', 'BranchNo'] },
      }),
    ).toThrow(ForbiddenException);
    expect(() => parseGatiRoutingPolicy({ branchColumns: { unknown: ['BranchNo'] } })).toThrow(ForbiddenException);
    expect(() => parseGatiRoutingPolicy({ branchColumns: { parties: ['x;drop'] } })).toThrow(ForbiddenException);
  });
});

describe('legacy Gati accepted SyncState', () => {
  it('records one non-null organisation-scoped state and replaces retry counters', async () => {
    const row = agent();
    const harness = new FenceHarness(row);
    const service = harness.service();
    const request = generation(row);
    const user = userFor(request);

    for (const received of [3, 3]) {
      await service.runGatiIngestion(user, request, 'parties', received, async () => ({
        entity: 'parties',
        received,
        upserted: received,
        skipped: 0,
        watermark: '2026-09-08T10:00:00.000Z',
      }));
    }

    expect(harness.stateWrites).toHaveLength(2);
    for (const write of harness.stateWrites as any[]) {
      expect(write.where.organisationId_sourceTable_storeId).toEqual({
        organisationId: 'org-a',
        sourceTable: 'PartyMst',
        storeId: SYNC_STATE_ORGANISATION_SENTINEL,
      });
      expect(write.update.rowsSynced).toBe(3);
      expect(write.update).not.toHaveProperty('increment');
    }
    expect(harness.auditRecord).toHaveBeenCalledTimes(2);
    expect(harness.auditRecord).toHaveBeenLastCalledWith(
      user,
      expect.objectContaining({
        action: 'sync.ingested',
        entityType: 'ConnectAgent',
        entityId: row.id,
        metadata: expect.objectContaining({
          routeEntity: 'parties',
          received: 3,
          sourceTable: 'PartyMst',
          profileId: request.profileId,
          profileHash: PROFILE_HASH,
          sourceInstanceHash: SOURCE_HASH,
          configRevision: request.configRevision,
          counts: { upserted: 3, skipped: 0 },
        }),
      }),
      harness.tx,
    );
  });

  it('uses the requested source table for raw state and never advances skipped/failed batches', async () => {
    const row = agent();
    const harness = new FenceHarness(row);
    const service = harness.service();
    const request = generation(row);
    const user = userFor(request);

    await service.runGatiIngestion(
      user,
      request,
      'raw',
      1,
      async () => ({
        entity: 'raw:Client Table',
        received: 1,
        upserted: 1,
        skipped: 0,
        watermark: null,
      }),
      'Client Table',
    );
    expect((harness.stateWrites[0] as any).create.sourceTable).toBe('Client Table');

    await service.runGatiIngestion(user, request, 'stock', 1, async () => ({
      entity: 'stock',
      received: 1,
      upserted: 0,
      skipped: 1,
      watermark: '2026-09-08T11:00:00.000Z',
    }));
    await expect(
      service.runGatiIngestion(user, request, 'stock', 1, async () => {
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');
    expect(harness.stateWrites).toHaveLength(1);
    expect(harness.auditRecord).toHaveBeenCalledTimes(2);
  });
});
