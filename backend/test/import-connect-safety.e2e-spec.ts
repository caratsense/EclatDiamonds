import { AuditService } from '../src/common/audit.service';
import { AuthUser } from '../src/common/auth-user';
import { StoreScopeService } from '../src/common/store-scope.service';
import { IMPORTERS } from '../src/integration/import/entity-importers';
import { ImportService } from '../src/integration/import/import.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PROFILE_HASH = 'b'.repeat(64);
const SOURCE_INSTANCE_HASH = 'c'.repeat(64);
const CONFIG_REVISION = 'server-revision-test';
const TOKEN_HASH = 'd'.repeat(64);
const SOURCE_NAMESPACE = SOURCE_INSTANCE_HASH.slice(0, 32);
const MACHINE: AuthUser = {
  id: 'agent:busy_test',
  name: 'BUSY test agent',
  email: '',
  role: 'head_office',
  organisationId: 'org_test',
  storeIds: [],
  allStores: true,
  isMachine: true,
  agentId: 'busy_test',
  agentTokenHash: TOKEN_HASH,
  agentConfigRevision: CONFIG_REVISION,
  connectorSourceSystem: 'busy',
};

function serviceFixture(config: Record<string, unknown>) {
  const prisma = {
    importBatch: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'batch_test' }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    party: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'party_test' }),
      update: jest.fn(),
    },
    connectAgent: {
      findFirst: jest.fn().mockResolvedValue({
        config,
        sourceInstanceHash: null,
        tokenHash: TOKEN_HASH,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new ImportService(
    prisma as unknown as PrismaService,
    { assertStoreAllowed: jest.fn() } as unknown as StoreScopeService,
    { record: jest.fn() } as unknown as AuditService,
  );
  return { service, prisma };
}

describe('Connect/import fail-closed safety', () => {
  it('requires a head-office-approved profile before a machine can write', async () => {
    const { service, prisma } = serviceFixture({ enabled: true });
    await expect(
      service.run(
        MACHINE,
        'customers',
        {
          buffer: Buffer.from(
            `External ID,Customer Name\nbusy:${SOURCE_NAMESPACE}:1,Blocked`,
          ),
          originalname: 'customers.csv',
        },
        [
          { sourceColumn: 'External ID', canonicalField: 'code' },
          { sourceColumn: 'Customer Name', canonicalField: 'name' },
        ],
        undefined,
        'busy',
        'a'.repeat(64),
        'busy-reviewed-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('approved by head office');
    expect(prisma.importBatch.findFirst).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
    expect(prisma.connectAgent.updateMany).not.toHaveBeenCalled();
  });

  it('requires the reviewed source descriptor before the first live write', async () => {
    const { service, prisma } = serviceFixture({
      enabled: true,
      expectedProfileHash: PROFILE_HASH,
      configRevision: CONFIG_REVISION,
    });
    await expect(
      service.run(
        MACHINE,
        'customers',
        {
          buffer: Buffer.from(
            `External ID,Customer Name\nbusy:${SOURCE_NAMESPACE}:1,Blocked`,
          ),
          originalname: 'customers.csv',
        },
        [
          { sourceColumn: 'External ID', canonicalField: 'code' },
          { sourceColumn: 'Customer Name', canonicalField: 'name' },
        ],
        undefined,
        'busy',
        'a'.repeat(64),
        'busy-reviewed-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('source descriptor hash to be approved');
    expect(prisma.importBatch.findFirst).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
    expect(prisma.connectAgent.updateMany).not.toHaveBeenCalled();
  });

  it('rejects warning-bearing machine rows before binding, receipt or domain writes', async () => {
    const { service, prisma } = serviceFixture({
      enabled: true,
      expectedProfileHash: PROFILE_HASH,
      expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
      configRevision: CONFIG_REVISION,
    });
    await expect(
      service.run(
        MACHINE,
        'customers',
        {
          buffer: Buffer.from(
            `External ID,Customer Name,Mobile\nbusy:${SOURCE_NAMESPACE}:warning,Warning Customer,+442071838750`,
          ),
          originalname: 'customers.csv',
        },
        [
          { sourceColumn: 'External ID', canonicalField: 'code' },
          { sourceColumn: 'Customer Name', canonicalField: 'name' },
          { sourceColumn: 'Mobile', canonicalField: 'phone' },
        ],
        undefined,
        'busy',
        'd'.repeat(64),
        'busy-reviewed-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('warning row');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
    expect(prisma.party.update).not.toHaveBeenCalled();
    expect(prisma.connectAgent.updateMany).not.toHaveBeenCalled();
  });

  it('does not erase catalogue attributes omitted by a later source snapshot', async () => {
    const product = {
      findFirst: jest.fn().mockResolvedValue({ id: 'product_existing', storeId: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    };
    const prisma = { product } as unknown as PrismaService;
    const importer = IMPORTERS.products;
    const minimal = importer.mapRow(
      { sku: 'busy:source:item-1', name: 'Renamed only' },
      { sourceSystem: 'busy', isMachine: true, neutralProduct: true },
    );
    expect(minimal).toMatchObject({ ok: true, warnings: [] });
    await importer.persist(prisma, 'org_test', undefined, minimal.value!, 'batch_1');
    expect(product.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'product_existing', organisationId: 'org_test' },
      data: { name: 'Renamed only' },
    });

    const explicit = importer.mapRow(
      {
        sku: 'busy:source:item-1',
        name: 'Steel Bolt',
        metal: 'Steel',
        category: 'Fastener',
        unitOfMeasure: 'pcs',
      },
      { sourceSystem: 'busy', isMachine: true, neutralProduct: true },
    );
    await importer.persist(prisma, 'org_test', undefined, explicit.value!, 'batch_2');
    expect(product.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'product_existing', organisationId: 'org_test' },
      data: expect.objectContaining({
        name: 'Steel Bolt',
        metal: 'unspecified',
        karat: 0,
        materialLabel: 'Steel',
        categoryLabel: 'Fastener',
        unitOfMeasure: 'pcs',
      }),
    });
  });

  it('holds ambiguous and cross-role Party matches instead of mutating one', async () => {
    const party = {
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    };
    const prisma = { party } as unknown as PrismaService;
    const value = {
      name: 'Shared Contact',
      code: null,
      phone: '9876500010',
      email: null,
      city: null,
      gstin: null,
      birthday: null,
      anniversary: null,
    };

    party.findMany.mockResolvedValueOnce([
      { id: 'customer_1', types: ['customer'] },
      { id: 'customer_2', types: ['customer'] },
    ]);
    await expect(
      IMPORTERS.customers.persist(prisma, 'org_test', 'store_a', value, 'batch_1'),
    ).resolves.toBe('duplicate');

    party.findMany.mockResolvedValueOnce([{ id: 'staff_1', types: ['staff'] }]);
    await expect(
      IMPORTERS.customers.persist(
        prisma,
        'org_test',
        'store_a',
        { ...value, code: 'manual-code' },
        'batch_2',
      ),
    ).resolves.toBe('duplicate');
    expect(party.update).not.toHaveBeenCalled();
    expect(party.create).not.toHaveBeenCalled();
  });

  it('never lets a source code target the synthetic aggregate store', async () => {
    const store = {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'store_new' }),
    };
    const mapped = IMPORTERS.stores.mapRow({ code: 'busy:source:1', name: 'Branch 1' });
    await IMPORTERS.stores.persist(
      { store } as unknown as PrismaService,
      'org_test',
      undefined,
      mapped.value!,
      'batch_1',
    );
    expect(store.findFirst).toHaveBeenCalledWith({
      where: { organisationId: 'org_test', code: 'busy:source:1', isAggregate: false },
      select: { id: true },
    });
  });
});
