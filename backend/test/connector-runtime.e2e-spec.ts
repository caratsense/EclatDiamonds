import type { AuthUser } from '../src/common/auth-user';
import type { ProvenanceService } from '../src/common/provenance.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ConnectorRegistry } from '../src/integration/connectors/connector-registry';
import { ConnectorRuntimeService } from '../src/integration/framework/connector-runtime.service';

const PROFILE_HASH = 'a'.repeat(64);
const SOURCE_HASH = 'b'.repeat(64);
const USER = { id: 'user-1', organisationId: 'org-1' } as AuthUser;

const TALLY = {
  sourceSystem: 'tally',
  name: 'Tally',
  description: 'Tally agent',
  status: 'connected',
  capabilities: {},
  entities: ['customers', 'products'],
  fileUpload: false,
};

function approvedAgent(overrides: Record<string, unknown> = {}) {
  return {
    sourceSystem: 'tally',
    status: 'active',
    lastSeenAt: new Date(),
    sourceInstanceHash: SOURCE_HASH,
    config: {
      enabled: true,
      expectedProfileHash: PROFILE_HASH,
      expectedSourceInstanceHash: SOURCE_HASH,
    },
    ...overrides,
  };
}

function machineBatch(
  id: string,
  status: string,
  discovered: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    targetStoreId: null,
    sourceSystem: 'tally',
    entity: 'customers',
    fileName: null,
    status,
    discovered,
    imported: status === 'completed' ? discovered : 0,
    updated: 0,
    skipped: 0,
    failed: status === 'failed' ? 1 : 0,
    duplicate: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    runKey: `${id}-run-key`,
    profileId: 'tally-master',
    profileHash: PROFILE_HASH,
    sourceInstanceHash: SOURCE_HASH,
    configRevision: 'revision-1',
    ...overrides,
  };
}

function fixture(input: {
  agents?: Record<string, any>[];
  batches?: Record<string, any>[];
  gatiDeliveryCount?: number;
  registryEntries?: Record<string, unknown>[];
}) {
  const batches = input.batches ?? [];
  const isBoundMachineReceipt = (batch: Record<string, any>) =>
    batch.runKey != null &&
    batch.profileId != null &&
    batch.profileHash != null &&
    batch.sourceInstanceHash != null &&
    batch.configRevision != null;
  const prisma = {
    connectAgent: { findMany: jest.fn().mockResolvedValue(input.agents ?? []) },
    syncState: {
      count: jest.fn().mockResolvedValue(input.gatiDeliveryCount ?? 0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    importBatch: {
      findMany: jest.fn().mockResolvedValue(batches),
      findFirst: jest.fn().mockResolvedValue(
        batches.find((batch) => isBoundMachineReceipt(batch)) ?? null,
      ),
      aggregate: jest.fn(),
      count: jest.fn().mockImplementation(async (args: any) => {
        if (args?.where?.runKey?.not === null) {
          return batches.filter(
            (batch) =>
              isBoundMachineReceipt(batch) &&
              batch.status === 'completed' &&
              batch.discovered > 0,
          ).length;
        }
        return 0;
      }),
    },
  };
  const entries = input.registryEntries ?? [TALLY];
  const registry = {
    list: jest.fn().mockReturnValue(entries),
    get: jest.fn((sourceSystem: string) =>
      entries.find((entry) => entry.sourceSystem === sourceSystem),
    ),
  };
  const provenance = {
    summary: jest.fn().mockResolvedValue({
      counts: {},
      remainingMigration: 'SourceLink pending',
    }),
  };
  return {
    prisma,
    service: new ConnectorRuntimeService(
      prisma as unknown as PrismaService,
      registry as unknown as ConnectorRegistry,
      provenance as unknown as ProvenanceService,
    ),
  };
}

describe('ConnectorRuntimeService tenant status', () => {
  it.each([
    {
      name: 'enabled, approved, pinned and fresh',
      agent: approvedAgent(),
      status: 'connected',
      reason: /approved agent checked in recently/i,
    },
    {
      name: 'disabled',
      agent: approvedAgent({ config: { enabled: false } }),
      status: 'disabled',
      reason: /disabled/i,
    },
    {
      name: 'not approved',
      agent: approvedAgent({ config: { enabled: true } }),
      status: 'needs_attention',
      reason: /setup required/i,
    },
    {
      name: 'approved but not source-pinned',
      agent: approvedAgent({ sourceInstanceHash: null }),
      status: 'needs_attention',
      reason: /source pin/i,
    },
    {
      name: 'reporting an error',
      agent: approvedAgent({ status: 'error' }),
      status: 'failed',
      reason: /reported an error/i,
    },
    {
      name: 'stale',
      agent: approvedAgent({
        lastSeenAt: new Date(Date.now() - 21 * 60 * 1000),
      }),
      status: 'needs_attention',
      reason: /stale/i,
    },
  ])('reports $name without overstating health', async ({ agent, status, reason }) => {
    const { service } = fixture({ agents: [agent] });

    const [runtime] = await service.list(USER);

    expect(runtime.status).toBe(status);
    expect(runtime.statusReason).toMatch(reason);
  });

  it('does not turn historical Gati delivery into current agent health', async () => {
    const { service } = fixture({
      agents: [],
      gatiDeliveryCount: 4,
      registryEntries: [{ ...TALLY, sourceSystem: 'gati', name: 'Gati' }],
    });

    const [runtime] = await service.list(USER);

    expect(runtime.status).toBe('needs_attention');
    expect(runtime.statusReason).toMatch(/delivered before.*no enrolled/i);
  });

  it('keeps a disabled Gati agent disabled even when old delivery rows exist', async () => {
    const { service } = fixture({
      agents: [approvedAgent({ sourceSystem: 'gati', config: { enabled: false } })],
      gatiDeliveryCount: 4,
      registryEntries: [{ ...TALLY, sourceSystem: 'gati', name: 'Gati' }],
    });

    const [runtime] = await service.list(USER);

    expect(runtime.status).toBe('disabled');
  });

  it('discover never calls an active-but-unpinned agent reachable', async () => {
    const { service, prisma } = fixture({
      agents: [
        {
          ...approvedAgent({ sourceInstanceHash: null }),
          id: 'agent-1',
          name: 'Back office',
          lastSyncAt: null,
          lastError: null,
        },
      ],
    });

    const discovered = await service.discover(USER, 'tally');

    expect(discovered).toMatchObject({
      reachable: false,
      status: 'needs_attention',
      statusReason: expect.stringMatching(/setup required/i),
      agents: [
        expect.objectContaining({
          status: 'needs_attention',
          storedStatus: 'active',
          statusReason: expect.stringMatching(/setup required/i),
        }),
      ],
    });
    expect(prisma.connectAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      }),
    );
  });

  it('does not describe a human-labelled fallback file as an agent delivery', async () => {
    const { service } = fixture({
      agents: [],
      batches: [
        {
          status: 'completed',
          runKey: null,
          profileId: null,
          profileHash: null,
          sourceInstanceHash: null,
          configRevision: null,
        },
      ],
    });

    const discovered = await service.discover(USER, 'tally');

    expect(discovered).toMatchObject({
      reachable: false,
      delivered: false,
      note: expect.stringMatching(/no tally connect agent/i),
    });
    expect(discovered.recentBatches).toHaveLength(1);
  });

  it('counts only a completed, bound machine receipt as an agent delivery', async () => {
    const { service } = fixture({
      agents: [
        {
          ...approvedAgent(),
          id: 'agent-1',
          name: 'Back office',
          lastSyncAt: new Date(),
          lastError: null,
        },
      ],
      batches: [
        {
          status: 'completed',
          discovered: 1,
          runKey: 'c'.repeat(64),
          profileId: 'tally-master',
          profileHash: PROFILE_HASH,
          sourceInstanceHash: SOURCE_HASH,
          configRevision: 'revision-1',
        },
      ],
    });

    const discovered = await service.discover(USER, 'tally');

    expect(discovered).toMatchObject({
      reachable: true,
      delivered: true,
      note: expect.stringMatching(/agent has delivered master-data batches/i),
    });
    const [publicBatch] = discovered.recentBatches ?? [];
    expect(publicBatch).toBeDefined();
    expect(publicBatch).not.toHaveProperty('runKey');
    expect(publicBatch).not.toHaveProperty('profileHash');
    expect(publicBatch).not.toHaveProperty('sourceInstanceHash');
    expect(publicBatch).not.toHaveProperty('configRevision');
  });

  it('requires review when the latest completed machine receipt contains no rows', async () => {
    const { service } = fixture({
      agents: [
        {
          ...approvedAgent(),
          id: 'agent-1',
          name: 'Back office',
          lastSyncAt: new Date(),
          lastError: null,
        },
      ],
      batches: [
        machineBatch('empty-batch', 'completed', 0),
        machineBatch('older-success', 'completed', 4),
      ],
    });

    await expect(service.discover(USER, 'tally')).resolves.toMatchObject({
      reachable: true,
      delivered: true,
      everDelivered: true,
      latestReceiptStatus: 'completed',
      status: 'needs_attention',
      statusReason: expect.stringMatching(/zero source rows/i),
      note: expect.stringMatching(/empty and needs review/i),
    });
  });

  it('does not let an older successful receipt mask the newest failed sync', async () => {
    const { service } = fixture({
      agents: [
        {
          ...approvedAgent(),
          id: 'agent-1',
          name: 'Back office',
          lastSyncAt: new Date(),
          lastError: null,
        },
      ],
      batches: [
        machineBatch('newest-failure', 'failed', 8),
        machineBatch('older-success', 'completed', 8),
      ],
    });

    await expect(service.discover(USER, 'tally')).resolves.toMatchObject({
      reachable: true,
      delivered: true,
      everDelivered: true,
      latestReceiptStatus: 'failed',
      status: 'failed',
      statusReason: expect.stringMatching(/latest connect receipt failed/i),
      note: expect.stringMatching(/latest tally agent receipt failed/i),
    });
  });

  it('reports a newest running receipt separately from historical delivery', async () => {
    const { service } = fixture({
      agents: [
        {
          ...approvedAgent(),
          id: 'agent-1',
          name: 'Back office',
          lastSyncAt: new Date(),
          lastError: null,
        },
      ],
      batches: [
        machineBatch('newest-running', 'running', 8),
        machineBatch('older-success', 'completed', 8),
      ],
    });

    const discovered = await service.discover(USER, 'tally');

    expect(discovered).toMatchObject({
      reachable: true,
      delivered: true,
      everDelivered: true,
      latestReceiptStatus: 'running',
      status: 'needs_attention',
      statusReason: expect.stringMatching(/still running/i),
      note: expect.stringMatching(/not a completed delivery/i),
    });
    expect(discovered.recentBatches?.[0]).not.toHaveProperty('runKey');
    expect(discovered.recentBatches?.[0]).not.toHaveProperty('profileId');
    expect(discovered.recentBatches?.[0]).not.toHaveProperty('profileHash');
    expect(discovered.recentBatches?.[0]).not.toHaveProperty('sourceInstanceHash');
    expect(discovered.recentBatches?.[0]).not.toHaveProperty('configRevision');
  });
});

describe('ConnectorRuntimeService reconciliation', () => {
  it('counts every finalized outcome while separating active and stale receipts', async () => {
    const { service, prisma } = fixture({});
    prisma.importBatch.aggregate.mockResolvedValue({
      _sum: {
        discovered: 10,
        imported: 2,
        updated: 2,
        skipped: 1,
        failed: 3,
        duplicate: 2,
      },
      _count: { _all: 3 },
    });
    prisma.importBatch.count.mockImplementation(async (args: any) => {
      if (args.where.status !== 'running') return 5;
      if (args.where.OR) return 1;
      return 2;
    });

    const result = await service.reconcile(USER);

    expect(prisma.importBatch.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organisationId: 'org-1',
          status: { in: ['completed', 'needs_review', 'failed'] },
        },
        _sum: expect.objectContaining({ skipped: true }),
      }),
    );
    expect(result.imports).toMatchObject({
      batches: 3,
      totalBatches: 5,
      inProgressBatches: 1,
      staleBatches: 1,
      skipped: 1,
      accounted: 10,
      unaccounted: 0,
      reconciled: true,
    });
  });

  it('surfaces an outcome-accounting gap instead of hiding it', async () => {
    const { service, prisma } = fixture({});
    prisma.importBatch.aggregate.mockResolvedValue({
      _sum: {
        discovered: 11,
        imported: 2,
        updated: 2,
        skipped: 1,
        failed: 3,
        duplicate: 2,
      },
      _count: { _all: 1 },
    });
    prisma.importBatch.count.mockImplementation(async (args: any) =>
      args.where.status === 'running' ? 0 : 1,
    );

    const result = await service.reconcile(USER);

    expect(result.imports).toMatchObject({
      discovered: 11,
      accounted: 10,
      unaccounted: 1,
      reconciled: false,
    });
  });
});
