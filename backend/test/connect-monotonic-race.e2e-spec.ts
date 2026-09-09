import { createHash } from 'node:crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ConnectService } from '../src/integration/connect/connect.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ConnectService monotonic heartbeat writes', () => {
  const rawToken = 'cxa_monotonic-heartbeat-token';
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not let a delayed older heartbeat restore stale error/status data', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));

    const releaseOlder = deferred();
    let writes = 0;
    const row: Record<string, any> = {
      id: 'agent-1',
      tokenHash,
      revokedAt: null,
      lastSeenAt: null,
      lastSyncAt: null,
      status: 'enrolled',
      lastError: null,
      lastStats: {},
      config: { enabled: true, configRevision: 'revision-1' },
      sourceSystem: 'busy',
      storeId: null,
    };

    const updateMany = jest.fn(async ({ where, data }: any) => {
      writes += 1;
      if (writes === 1) await releaseOlder.promise;

      const cutoff = where.AND[0].OR[1].lastSeenAt.lt as Date;
      const freshEnough = row.lastSeenAt == null || row.lastSeenAt.getTime() < cutoff.getTime();
      const credentialMatches =
        row.id === where.id && row.tokenHash === where.tokenHash && row.revokedAt == null;
      if (!freshEnough || !credentialMatches) return { count: 0 };

      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) row[key] = value;
      }
      return { count: 1 };
    });
    const findUnique = jest.fn(async () => ({ ...row }));
    const service = new ConnectService(
      { connectAgent: { updateMany, findUnique } } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const older = service.heartbeat('agent-1', rawToken, {
      status: 'error',
      error: 'old source failure',
      stats: { phase: 'old-run' },
    });
    await Promise.resolve();

    jest.setSystemTime(new Date('2026-09-08T10:00:01.000Z'));
    await expect(
      service.heartbeat('agent-1', rawToken, {
        status: 'active',
        stats: { phase: 'new-run' },
      }),
    ).resolves.toMatchObject({ acknowledged: true });

    releaseOlder.resolve();
    await expect(older).rejects.toBeInstanceOf(ForbiddenException);
    expect(row).toMatchObject({
      status: 'active',
      lastError: null,
      lastStats: { phase: 'new-run' },
      lastSeenAt: new Date('2026-09-08T10:00:01.000Z'),
    });
  });

  it.each(['b'.repeat(64), null])(
    'rejects source approval %p when it contradicts an immutable pin',
    async (expectedSourceInstanceHash) => {
      const update = jest.fn();
      const service = new ConnectService(
        {
          connectAgent: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'agent-1',
              organisationId: 'org-1',
              sourceSystem: 'busy',
              sourceInstanceHash: 'a'.repeat(64),
            }),
            update,
          },
        } as any,
        {} as any,
        {} as any,
        {} as any,
      );

      await expect(
        service.configure(
          { id: 'owner-1', organisationId: 'org-1' } as any,
          'agent-1',
          { expectedSourceInstanceHash },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('preserves an immutable source pin when a replacement config omits it', async () => {
    const sourceInstanceHash = 'a'.repeat(64);
    const row = {
      id: 'agent-1',
      organisationId: 'org-1',
      name: 'Pinned connector',
      sourceSystem: 'busy',
      sourceInstanceHash,
      config: {},
    };
    const update = jest.fn(async ({ data }) => ({ ...row, ...data }));
    const service = new ConnectService(
      {
        connectAgent: {
          findFirst: jest.fn().mockResolvedValue(row),
          update,
        },
      } as any,
      {} as any,
      { record: jest.fn() } as any,
      {} as any,
    );

    await service.configure(
      { id: 'owner-1', organisationId: 'org-1' } as any,
      'agent-1',
      { enabled: true, syncIntervalMinutes: 15 },
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          config: expect.objectContaining({
            expectedSourceInstanceHash: sourceInstanceHash,
          }),
        }),
      }),
    );
  });
});
