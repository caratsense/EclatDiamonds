import { BadRequestException } from '@nestjs/common';

import {
  ConnectService,
  sanitizeAgentDiagnostic,
} from '../src/integration/connect/connect.service';

describe('Connect approved policy safety', () => {
  const user = {
    id: 'owner-1',
    organisationId: 'org-1',
    storeIds: ['store-1'],
  } as any;

  function fixture(sourceSystem = 'gati', storeExists = true) {
    const base = {
      id: 'agent-1',
      organisationId: 'org-1',
      name: 'Client connector',
      sourceSystem,
      storeId: null,
      status: 'enrolled',
      tokenPrefix: 'cxa_test',
      agentVersion: null,
      hostname: null,
      os: null,
      lastSeenAt: null,
      lastSyncAt: null,
      lastError: null,
      lastStats: {},
      config: {},
      revokedAt: null,
      createdAt: new Date(),
    };
    let savedConfig: Record<string, unknown> = {};
    const prisma = {
      connectAgent: {
        findFirst: jest.fn().mockResolvedValue(base),
        findMany: jest.fn().mockResolvedValue([base]),
        update: jest.fn().mockImplementation(async ({ data }) => {
          savedConfig = data.config;
          return { ...base, status: data.status, config: data.config };
        }),
      },
      store: {
        findFirst: jest.fn().mockResolvedValue(storeExists ? { id: 'store-1' } : null),
      },
    };
    const service = new ConnectService(
      prisma as any,
      { assertStoreAllowed: jest.fn() } as any,
      { record: jest.fn() } as any,
      {} as any,
    );
    return { service, prisma, base, savedConfig: () => savedConfig };
  }

  it('normalizes and revision-binds the allowlisted Gati tenant-routing policy', async () => {
    const { service, prisma, savedConfig } = fixture();
    await service.configure(user, 'agent-1', {
      enabled: true,
      defaultStoreId: 'store-1',
      unattributedMode: 'default',
      branchColumns: {
        parties: ['EclatBranchId', 'BranchNo'],
        stock: [],
        ledger: ['BookBranchId'],
      },
    });

    expect(prisma.store.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'store-1',
        organisationId: 'org-1',
        isAggregate: false,
        isHolding: false,
        attendanceOnly: false,
        status: { not: 'closed' },
      },
      select: { id: true },
    });
    expect(savedConfig()).toEqual(
      expect.objectContaining({
        enabled: true,
        defaultStoreId: 'store-1',
        unattributedMode: 'default',
        branchColumns: {
          parties: ['EclatBranchId', 'BranchNo'],
          stock: [],
          ledger: ['BookBranchId'],
        },
        configRevision: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );

    const policy = service.identity({
      id: 'agent-1',
      name: 'Client connector',
      sourceSystem: 'gati',
      storeId: null,
      organisationId: 'org-1',
      sourceInstanceHash: null,
      config: savedConfig() as any,
    });
    expect(policy).toMatchObject({
      defaultStoreId: 'store-1',
      unattributedMode: 'default',
      branchColumns: {
        parties: ['EclatBranchId', 'BranchNo'],
        stock: [],
        ledger: ['BookBranchId'],
      },
    });
  });

  it('returns fail-safe routing defaults when no Gati override is approved', () => {
    const { service } = fixture();
    expect(
      service.identity({
        id: 'agent-1',
        name: 'Client connector',
        sourceSystem: 'gati',
        storeId: null,
        organisationId: 'org-1',
        sourceInstanceHash: null,
        config: {},
      }),
    ).toMatchObject({
      defaultStoreId: null,
      unattributedMode: 'holding',
      branchColumns: {},
    });
  });

  it.each([
    {
      label: 'an unsupported entity',
      config: { branchColumns: { payroll: ['BranchNo'] } },
    },
    {
      label: 'more than eight candidates',
      config: {
        branchColumns: {
          stock: Array.from({ length: 9 }, (_, index) => `Branch${index}`),
        },
      },
    },
    {
      label: 'an unsafe column name',
      config: { branchColumns: { sales: ['BranchNo; DROP TABLE Store'] } },
    },
    {
      label: 'duplicate candidates',
      config: { branchColumns: { orders: ['BranchNo', 'BranchNo'] } },
    },
    {
      label: 'default mode without a reviewed default store',
      config: { unattributedMode: 'default' },
    },
  ])('rejects routing policy containing $label', async ({ config }) => {
    const { service, prisma } = fixture();
    await expect(service.configure(user, 'agent-1', config)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.connectAgent.update).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant/aggregate default store and routing keys on non-Gati agents', async () => {
    const missingStore = fixture('gati', false);
    await expect(
      missingStore.service.configure(user, 'agent-1', {
        defaultStoreId: 'foreign-store',
        unattributedMode: 'default',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const busy = fixture('busy');
    await expect(
      busy.service.configure(user, 'agent-1', {
        unattributedMode: 'holding',
      }),
    ).rejects.toThrow(/only for Gati/i);
    expect(busy.prisma.connectAgent.update).not.toHaveBeenCalled();
  });

  it('projects only allowlisted policy config and re-sanitizes legacy diagnostics', async () => {
    const { service, prisma, base } = fixture();
    prisma.connectAgent.findMany.mockResolvedValue([
      {
        ...base,
        config: {
          enabled: true,
          expectedProfileHash: 'a'.repeat(64),
          syncIntervalMinutes: 15,
          branchColumns: {
            parties: ['BranchNo'],
            payroll: ['SecretColumn'],
          },
          password: 'database password',
          clientSecret: 'oauth secret',
          arbitraryLegacyKey: { nested: 'must not leave the service' },
        },
        lastError: 'apiKey="visible secret with spaces"; source connection refused',
      },
    ]);

    const [view] = await service.list(user);

    expect(view.config).toEqual({
      enabled: true,
      expectedProfileHash: 'a'.repeat(64),
      syncIntervalMinutes: 15,
      branchColumns: { parties: ['BranchNo'] },
    });
    expect(view.config).not.toHaveProperty('password');
    expect(view.config).not.toHaveProperty('clientSecret');
    expect(view.config).not.toHaveProperty('arbitraryLegacyKey');
    expect(view.lastError).toContain('apiKey=[REDACTED]');
    expect(view.lastError).toContain('source connection refused');
    expect(view.lastError).not.toContain('visible secret');
  });

  it('redacts labelled, quoted, braced, spaced and token-shaped credentials', () => {
    const sanitized = sanitizeAgentDiagnostic([
      '"clientSecret": "quoted alpha beta";',
      'api_key={braced gamma delta};',
      "accessKey='quoted epsilon zeta';",
      'ssl key spaced eta theta;',
      'Authorization: Bearer bearer-secret;',
      'https://alice:uri-password@example.test/path',
      'cxa_connect-token-value',
      'privateKey=-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----;',
      'source connection refused',
    ].join(' '));

    expect(sanitized).not.toMatch(
      /quoted alpha|braced gamma|quoted epsilon|spaced eta|bearer-secret|uri-password|connect-token-value|private-key-material/i,
    );
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).toContain('[REDACTED]@example.test');
    expect(sanitized).toContain('source connection refused');
  });
});
