import { BadRequestException } from '@nestjs/common';

import { SyncService } from '../src/sync/sync.service';

/**
 * Legacy Gati store fallback safety.
 *
 * Store ids are global primary keys, while imported rows are tenant-owned. A
 * fallback selected only by id can therefore create a cross-tenant relation
 * even though every business-row upsert correctly includes organisationId.
 * These focused tests exercise the private resolver because that is the common
 * path used by parties, stock, sales, orders and ledger ingestion.
 */
describe('legacy sync tenant-owned fallback stores', () => {
  function serviceWith(store: Record<string, jest.Mock>, fallback = 'foreign-store') {
    return new SyncService(
      { store } as any,
      {
        get: (key: string) =>
          key === 'SYNC_DEFAULT_STORE_ID'
            ? fallback
            : key === 'SYNC_UNATTRIBUTED'
              ? 'default'
              : undefined,
      } as any,
      {} as any,
      {} as any,
    );
  }

  it('refuses a process fallback unless that exact store belongs to the acting tenant', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = serviceWith({ findFirst });

    await expect(
      (service as any).assertStore('org_b'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-store',
        organisationId: 'org_b',
        isAggregate: false,
        attendanceOnly: false,
        status: { not: 'closed' },
      },
      select: { id: true },
    });
  });

  it('does not consult a foreign fallback when every row resolves to a tenant branch', async () => {
    const findFirst = jest.fn().mockImplementation(({ where }: any) => {
      if (where.organisationId === 'org_b' && where.legacyId === 'BRANCH-B') {
        return Promise.resolve({ id: 'store-b' });
      }
      return Promise.resolve(null);
    });
    const service = serviceWith({ findFirst });
    const resolver = await (service as any).branchResolver('parties', 'org_b');

    await expect(
      resolver.resolveRequired({ EclatBranchId: 'BRANCH-B' }),
    ).resolves.toBe('store-b');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('creates and then reuses a distinct holding-store id for each tenant', async () => {
    const created: Array<Record<string, unknown>> = [];
    let holdingExists = false;
    const findFirst = jest.fn().mockImplementation(({ where }: any) => {
      if (
        holdingExists &&
        where.id === 'unassigned:org_b' &&
        where.organisationId === 'org_b'
      ) {
        return Promise.resolve({ id: 'unassigned:org_b', isHolding: true });
      }
      return Promise.resolve(null);
    });
    const create = jest.fn().mockImplementation(({ data }: any) => {
      created.push(data);
      holdingExists = true;
      return Promise.resolve(data);
    });
    const service = new SyncService(
      { store: { count: jest.fn().mockResolvedValue(2), findFirst, create } } as any,
      { get: () => undefined } as any,
      {} as any,
      {} as any,
    );

    await expect(
      (service as any).unattributedStoreId('org_b'),
    ).resolves.toBe('unassigned:org_b');
    await expect(
      (service as any).unattributedStoreId('org_b'),
    ).resolves.toBe('unassigned:org_b');

    expect(create).toHaveBeenCalledTimes(1);
    expect(created[0]).toMatchObject({
      id: 'unassigned:org_b',
      organisationId: 'org_b',
      isActive: false,
      isHolding: true,
    });
  });
});
