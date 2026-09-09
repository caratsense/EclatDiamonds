import { createHash } from 'crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ConnectService } from '../src/integration/connect/connect.service';

describe('Connect heartbeat revocation/rotation fence', () => {
  const token = 'cxa_test-race-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');

  function serviceWith(connectAgent: Record<string, jest.Mock>) {
    const prisma = { connectAgent };
    return {
      prisma,
      service: new ConnectService(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
      ),
    };
  }

  it('refuses the liveness write when revoke or rotation wins after authentication', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findUnique = jest.fn();
    const { service } = serviceWith({ updateMany, findUnique });

    await expect(
      service.heartbeat('agent-1', token, { status: 'active' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'agent-1',
          tokenHash,
          revokedAt: null,
        }),
      }),
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses a stale response when rotation wins just after the fenced write', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockResolvedValue({
      id: 'agent-1',
      tokenHash: 'f'.repeat(64),
      revokedAt: null,
      config: {},
      sourceSystem: 'gati',
      storeId: null,
    });
    const { service } = serviceWith({ updateMany, findUnique });

    await expect(
      service.heartbeat('agent-1', token, { status: 'active' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not reuse a pre-rotation heartbeat to render an enrolled token active', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'agent-1',
        name: 'Store connector',
        sourceSystem: 'busy',
        storeId: null,
        store: null,
        status: 'enrolled',
        tokenPrefix: 'cxa_test',
        agentVersion: '0.3.0',
        hostname: 'store-pc',
        os: 'Windows',
        lastSeenAt: new Date(),
        lastSyncAt: null,
        lastError: null,
        lastStats: {},
        config: { enabled: true },
        revokedAt: null,
        createdAt: new Date(),
      },
    ]);
    const { service } = serviceWith({ findMany });

    await expect(
      service.list({ organisationId: 'org-1' } as any),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'enrolled',
        statusReason: expect.stringMatching(/current token/i),
      }),
    ]);
  });

  it('renders an explicitly disabled agent disabled even with a fresh heartbeat', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'agent-1',
        name: 'Store connector',
        sourceSystem: 'busy',
        storeId: null,
        store: null,
        status: 'active',
        tokenPrefix: 'cxa_test',
        agentVersion: '0.3.0',
        hostname: 'store-pc',
        os: 'Windows',
        lastSeenAt: new Date(),
        lastSyncAt: null,
        lastError: null,
        lastStats: {},
        config: { enabled: false },
        revokedAt: null,
        createdAt: new Date(),
      },
    ]);
    const { service } = serviceWith({ findMany });

    await expect(
      service.list({ organisationId: 'org-1' } as any),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'disabled',
        statusReason: expect.stringMatching(/disabled by head office/i),
      }),
    ]);
  });

  it('heartbeat then token rotation requires the replacement token to check in', async () => {
    const row: Record<string, any> = {
      id: 'agent-1',
      organisationId: 'org-1',
      name: 'Store connector',
      sourceSystem: 'busy',
      storeId: null,
      store: null,
      status: 'enrolled',
      tokenHash,
      tokenPrefix: 'cxa_test',
      agentVersion: null,
      hostname: null,
      os: null,
      lastSeenAt: null,
      lastSyncAt: null,
      lastError: null,
      lastStats: {},
      config: { enabled: true },
      revokedAt: null,
      createdAt: new Date(),
    };
    const connectAgent = {
      findFirst: jest.fn().mockImplementation(async () => ({ ...row })),
      findUnique: jest.fn().mockImplementation(async () => ({ ...row })),
      findMany: jest.fn().mockImplementation(async () => [{ ...row }]),
      updateMany: jest.fn().mockImplementation(async ({ data }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) row[key] = value;
        }
        return { count: 1 };
      }),
      update: jest.fn().mockImplementation(async ({ data }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) row[key] = value;
        }
        return { ...row };
      }),
    };
    const service = new ConnectService(
      { connectAgent } as any,
      {} as any,
      { record: jest.fn() } as any,
      {} as any,
    );

    await service.heartbeat('agent-1', token, { status: 'active' });
    expect(row.lastSeenAt).toBeInstanceOf(Date);
    await service.rotate(
      { id: 'owner-1', organisationId: 'org-1' } as any,
      'agent-1',
    );
    const [view] = await service.list({ organisationId: 'org-1' } as any);

    expect(view).toMatchObject({ status: 'enrolled', lastSeenAt: null });
    expect(connectAgent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'enrolled', lastSeenAt: null }),
      }),
    );
  });

  it('rejects an out-of-order successful sync without changing liveness', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const lastSyncAt = new Date(Date.now() - 60_000);
    const findUnique = jest.fn().mockResolvedValue({
      tokenHash,
      revokedAt: null,
      lastSyncAt,
    });
    const { service } = serviceWith({ updateMany, findUnique });

    await expect(
      service.heartbeat('agent-1', token, {
        status: 'active',
        syncedAt: new Date(lastSyncAt.getTime() - 1_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ lastSyncAt: null }, { lastSyncAt: { lte: expect.any(Date) } }],
        }),
      }),
    );
  });

  it.each([
    {
      label: 'a future timestamp',
      input: {
        status: 'active' as const,
        syncedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
    {
      label: 'an old timestamp outside the reporting window',
      input: {
        status: 'active' as const,
        syncedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      },
    },
    {
      label: 'an error heartbeat',
      input: {
        status: 'error' as const,
        error: 'source unavailable',
        syncedAt: new Date().toISOString(),
      },
    },
    {
      label: 'a heartbeat with no explicit success status',
      input: { syncedAt: new Date().toISOString() },
    },
  ])('rejects syncedAt from $label before any liveness write', async ({ input }) => {
    const updateMany = jest.fn();
    const { service } = serviceWith({ updateMany });
    await expect(service.heartbeat('agent-1', token, input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('accepts a bounded monotonic syncedAt only on explicit healthy success', async () => {
    const syncedAt = new Date(Date.now() - 1_000).toISOString();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockResolvedValue({
      id: 'agent-1',
      tokenHash,
      revokedAt: null,
      config: {},
      sourceSystem: 'busy',
      storeId: null,
    });
    const { service } = serviceWith({ updateMany, findUnique });

    await expect(
      service.heartbeat('agent-1', token, { status: 'active', syncedAt }),
    ).resolves.toMatchObject({ acknowledged: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSyncAt: new Date(syncedAt) }),
      }),
    );
  });
});
