import { Prisma, Role } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { PartiesService } from './parties.service';

/**
 * A customer with no branch belongs to head office.
 *
 * The client, 23 Nov: "people who have no branch should be visible only to head
 * office, from where they could be reassigned."
 *
 * Seventeen active customers in production have no branch — every one of them
 * arrived from a message that reached us before routing knew a shop. The
 * directory used to show them to all eleven branches, which is eleven shops
 * able to claim and message the same person.
 *
 * The three things tested here are ONE feature, and the comments on
 * `directoryScope` say why: hiding the unbranched from branch staff takes them
 * away from the people most likely to recognise the name, so it is only
 * defensible while head office can list exactly those customers and hand each
 * one to a branch. A test that let the queue break while the hiding kept
 * working would be testing the dangerous half on its own.
 */

const HEAD_OFFICE: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@nibhana.in',
  role: Role.head_office,
  organisationId: 'org1',
  storeIds: ['surat-main', 'mumbai-bandra'],
  allStores: true,
};

const MANAGER: AuthUser = {
  id: 'u2',
  name: 'Devansh',
  email: 'devansh@nibhana.in',
  role: Role.store_manager,
  organisationId: 'org1',
  storeIds: ['mumbai-bandra'],
  allStores: false,
};

/** Enough of a row for `PARTY_SELECT` to map without Prisma. */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p1',
    name: 'Rajesh Agarwal',
    originalName: null,
    code: null,
    types: ['customer'],
    phone: '9825012345',
    whatsapp: null,
    email: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    pincode: null,
    gstin: null,
    birthday: null,
    anniversary: null,
    creditLimit: null,
    isBlacklisted: false,
    legacyId: null,
    storeId: null,
    store: null,
    createdAt: new Date('2026-10-07T00:00:00.000Z'),
    archivedAt: null,
    archiveReason: null,
    archivedBy: null,
    _count: { sales: 0 },
    partyTagAssignments: [],
    ...over,
  };
}

/**
 * A Prisma stand-in that records the `where` the directory asked for. The real
 * StoreScopeService composes that clause, so the scope under test is the one
 * production runs, not a stub of it.
 */
function harness(stored: ReturnType<typeof row> | null = null) {
  const wheres: Prisma.PartyWhereInput[] = [];
  const updates: { id: string; data: { storeId: string } }[] = [];
  const audited: {
    action: string;
    storeId?: string | null;
    metadata?: Record<string, unknown>;
  }[] = [];

  const prisma = {
    party: {
      count: ({ where }: { where: Prisma.PartyWhereInput }) => {
        wheres.push(where);
        return Promise.resolve(0);
      },
      findMany: ({ where }: { where: Prisma.PartyWhereInput }) => {
        wheres.push(where);
        return Promise.resolve([]);
      },
      findFirst: () => Promise.resolve(stored),
      findUniqueOrThrow: () => Promise.resolve(stored),
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: { storeId: string };
      }) => {
        updates.push({ id: where.id, data });
        return Promise.resolve({ ...stored, ...data, store: { name: 'Mumbai - Bandra' } });
      },
    },
    store: {
      // Every branch in these tests is an ordinary trading shop.
      findUnique: () =>
        Promise.resolve({
          name: 'Mumbai - Bandra',
          attendanceOnly: false,
          isHolding: false,
          status: 'open',
        }),
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };

  const service = new PartiesService(
    prisma as never,
    new StoreScopeService(prisma as never),
    {
      record: (
        _u: AuthUser,
        e: { action: string; storeId?: string | null; metadata?: Record<string, unknown> },
      ) => {
        audited.push({ action: e.action, storeId: e.storeId, metadata: e.metadata });
        return Promise.resolve();
      },
    } as never,
    null as never,
  );

  return { service, wheres, updates, audited };
}

/** The branch clause the directory ANDed in, for the assertions below. */
function scopeClause(where: Prisma.PartyWhereInput) {
  return (where.AND as Prisma.PartyWhereInput[])[0];
}

describe('who can see a customer with no branch', () => {
  const page = { page: 1, pageSize: 50 };

  it("keeps the unbranched out of a store manager's directory", async () => {
    const { service, wheres } = harness();

    await service.list(MANAGER, { type: 'customer' }, undefined, page);

    // A plain branch clause — no `{ storeId: null }` arm. This is the client's
    // rule, and it is the line that stops eleven branches each seeing the same
    // seventeen people.
    expect(scopeClause(wheres[0])).toEqual({ storeId: { in: ['mumbai-bandra'] } });
  });

  it("keeps them in head office's directory", async () => {
    const { service, wheres } = harness();

    await service.list(HEAD_OFFICE, { type: 'customer' }, undefined, page);

    expect(scopeClause(wheres[0])).toEqual({
      OR: [{ storeId: { in: ['surat-main', 'mumbai-bandra'] } }, { storeId: null }],
    });
  });

  it('still shows them to head office when a branch is chosen in the switcher', async () => {
    const { service, wheres } = harness();

    await service.list(HEAD_OFFICE, { type: 'customer' }, 'surat-main', page);

    // Narrowing to a branch must not empty the triage queue: an unbranched
    // customer is not AT another branch, so the branch choice has nothing to
    // exclude there.
    expect(scopeClause(wheres[0])).toEqual({
      OR: [{ storeId: 'surat-main' }, { storeId: null }],
    });
  });

  it('lists exactly the unbranched ones when head office asks for the queue', async () => {
    const { service, wheres } = harness();

    await service.list(HEAD_OFFICE, { type: 'customer', unbranched: true }, undefined, page);

    // Seventeen customers hidden among eight hundred is the same invisibility
    // with a different owner, so the queue is a filter of its own.
    expect(wheres[0].storeId).toBeNull();
  });

  it('does not narrow to the queue unless it was asked for', async () => {
    const { service, wheres } = harness();

    await service.list(HEAD_OFFICE, { type: 'customer' }, undefined, page);

    expect('storeId' in wheres[0]).toBe(false);
  });
});

describe('handing a customer to a branch', () => {
  it('sets the branch and records who moved them', async () => {
    const { service, updates, audited } = harness(row());

    const result = await service.assignBranch(HEAD_OFFICE, 'p1', 'mumbai-bandra');

    expect(updates).toEqual([{ id: 'p1', data: { storeId: 'mumbai-bandra' } }]);
    expect(result.storeId).toBe('mumbai-bandra');
    expect(result.storeName).toBe('Mumbai - Bandra');
    expect(audited).toEqual([
      {
        action: 'crm.contact_branch_assigned',
        storeId: 'mumbai-bandra',
        metadata: { from: null, to: 'mumbai-bandra' },
      },
    ]);
  });

  it('moves a customer who is already at another branch', async () => {
    const { service, updates, audited } = harness(row({ storeId: 'surat-main' }));

    await service.assignBranch(HEAD_OFFICE, 'p1', 'mumbai-bandra');

    expect(updates).toEqual([{ id: 'p1', data: { storeId: 'mumbai-bandra' } }]);
    // The move the duplicate refusal has been telling managers to ask for —
    // "Ask head office to reassign them to your branch" — had no answer before.
    expect(audited[0].metadata).toEqual({ from: 'surat-main', to: 'mumbai-bandra' });
  });

  it('refuses a Gati-synced customer rather than reverting overnight', async () => {
    const { service, updates } = harness(row({ legacyId: '4412' }));

    await expect(
      service.assignBranch(HEAD_OFFICE, 'p1', 'mumbai-bandra'),
    ).rejects.toThrow(/Change their branch in Gati instead/);

    // `syncParties` writes `storeId` on every run, so this would hold until the
    // next sync and then take the customer off the shop's list again.
    expect(updates).toEqual([]);
  });

  it('writes nothing when the customer is already at that branch', async () => {
    const { service, updates, audited } = harness(row({ storeId: 'mumbai-bandra' }));

    const result = await service.assignBranch(HEAD_OFFICE, 'p1', 'mumbai-bandra');

    expect(result.id).toBe('p1');
    expect(updates).toEqual([]);
    // The trail is for decisions that changed something.
    expect(audited).toEqual([]);
  });

  it('refuses a branch outside the caller\'s organisation', async () => {
    const { service, updates } = harness(row());

    await expect(
      service.assignBranch(HEAD_OFFICE, 'p1', 'another-tenants-shop'),
    ).rejects.toThrow('Store not in your scope');

    expect(updates).toEqual([]);
  });
});
