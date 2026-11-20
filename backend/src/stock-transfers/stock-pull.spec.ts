import { Role, StockStatus } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { StockTransfersService } from './stock-transfers.service';
import { ALLOWED_NEXT, submitTarget } from './stock-transfer-status';
import { pullableStockView, pullableStockWhere } from './pullable-stock';

/**
 * A branch asking another branch for a piece.
 *
 * A customer stands at Bandra wanting something that is at Borivali. Until now
 * Bandra could not see it was there, let alone ask for it — transfers were
 * source-initiated, so a salesperson could only send stock away (DECISIONS.md,
 * 10 Oct).
 *
 * Three things have to hold, and they are what these tests are about: the
 * picker shows another branch's shelf and NOTHING else about it, nobody answers
 * their own request, and the branch holding the piece can say no as easily as
 * it can say yes.
 */

const ORG = 'org1';

/** The two Mumbai branches from production, and the two places nobody runs. */
const STORES: Record<string, any> = {
  'mumbai-bandra': {
    id: 'mumbai-bandra',
    name: 'MUMBAI BANDRA',
    code: 'A001 MUBD',
    isActive: true,
    isAggregate: false,
    isHolding: false,
    attendanceOnly: false,
    status: 'active',
    organisationId: ORG,
  },
  'mumbai-borivali': {
    id: 'mumbai-borivali',
    name: 'MUMBAI BORIVALI',
    code: 'A002 MUBO',
    isActive: true,
    isAggregate: false,
    isHolding: false,
    attendanceOnly: false,
    status: 'active',
    organisationId: ORG,
  },
  unassigned: {
    id: 'unassigned',
    name: 'Unassigned — needs a branch',
    code: null,
    isActive: true,
    isAggregate: false,
    isHolding: true,
    attendanceOnly: false,
    status: 'pending',
    organisationId: ORG,
  },
  'other-org-branch': {
    id: 'other-org-branch',
    name: 'SOMEBODY ELSE',
    code: 'X001',
    isActive: true,
    isAggregate: false,
    isHolding: false,
    attendanceOnly: false,
    status: 'active',
    organisationId: 'org2',
  },
};

/** A piece on Borivali's shelf, with every number the asker must not be shown. */
const BORIVALI_PIECE = {
  id: 'piece-1',
  sku: 'RNG-001',
  name: 'Solitaire ring',
  styleNumber: 'ST-900',
  vin: 'NB-0001',
  category: 'ring',
  metal: 'gold_18k',
  karat: 18,
  grossWeight: 4.25,
  status: 'in_stock' as StockStatus,
  storeId: 'mumbai-borivali',
  organisationId: ORG,
  tagPrice: 185000,
  mrp: 199000,
  cost: 140000,
  huid: 'ABC123',
  store: { name: 'MUMBAI BORIVALI' },
  product: { name: 'Solitaire ring', styleNumber: 'ST-900' },
};

function user(over: Partial<AuthUser>): AuthUser {
  return {
    id: 'u-sales',
    name: 'Rhea',
    email: 'rhea@nibhana.in',
    role: Role.salesperson,
    organisationId: ORG,
    storeIds: ['mumbai-bandra'],
    allStores: false,
    ...over,
  } as AuthUser;
}

const BANDRA_SALES = user({ id: 'u-sales', storeIds: ['mumbai-bandra'] });
const BORIVALI_MANAGER = user({
  id: 'u-bori-mgr',
  name: 'Kunal',
  role: Role.store_manager,
  storeIds: ['mumbai-borivali'],
});
const BANDRA_MANAGER = user({
  id: 'u-bandra-mgr',
  name: 'Priya',
  role: Role.store_manager,
  storeIds: ['mumbai-bandra'],
});
/** One of the five production users who run more than one branch. */
const BOTH_BRANCHES_MANAGER = user({
  id: 'u-both',
  name: 'Devang',
  role: Role.store_manager,
  storeIds: ['mumbai-bandra', 'mumbai-borivali'],
});
const HEAD_OFFICE = user({
  id: 'u-ho',
  name: 'Ayushi',
  role: Role.head_office,
  storeIds: Object.keys(STORES),
  allStores: true,
});

/** A pull as it sits waiting for the holding branch to answer. */
function pendingPull(over: Record<string, any> = {}) {
  return {
    id: 'tr-1',
    ref: 'ST-A001 MUBD-001',
    organisationId: ORG,
    status: 'pending_source',
    initiatedBy: 'destination',
    fromStoreId: 'mumbai-borivali',
    toStoreId: 'mumbai-bandra',
    reason: null,
    requestedById: BANDRA_SALES.id,
    sourceDecidedById: null,
    sourceDecidedAt: null,
    items: [{ stockItemId: 'piece-1', sku: 'RNG-001', name: 'Solitaire ring' }],
    fromStore: { name: 'MUMBAI BORIVALI' },
    toStore: { name: 'MUMBAI BANDRA' },
    ...over,
  };
}

/**
 * The service wired to in-memory stores and pieces, with the REAL
 * StoreScopeService — the scoping rules are what is on trial here, so stubbing
 * them would test nothing.
 */
function build(transfer: Record<string, any> = pendingPull()) {
  const emitted: { to: string; role?: Role; title: string }[] = [];
  const stockFindManyArgs: any[] = [];
  let row: any = transfer;

  const prisma: any = {
    store: {
      findUnique: async ({ where }: any) => STORES[where.id] ?? null,
    },
    stockItem: {
      findMany: async (args: any) => {
        stockFindManyArgs.push(args);
        if (args.where?.id?.in) {
          return args.where.id.in.includes(BORIVALI_PIECE.id) ? [BORIVALI_PIECE] : [];
        }
        const w = args.where ?? {};
        const matches =
          w.organisationId === BORIVALI_PIECE.organisationId &&
          w.storeId === BORIVALI_PIECE.storeId &&
          (w.status?.in ?? []).includes(BORIVALI_PIECE.status);
        return matches ? [BORIVALI_PIECE] : [];
      },
    },
    stockTransfer: {
      findUnique: async () => row ?? null,
      create: async ({ data }: any) => {
        row = { ...pendingPull(), ...data, status: data.status, items: data.items.create };
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        if (!row || (where.status && row.status !== where.status)) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
    user: { findMany: async () => [] },
    // Cancel releases any reservation alongside the status change, so it runs
    // in a transaction; here the same client answers for both.
    $transaction: async (fn: any) => fn(prisma),
  };

  const svc = new StockTransfersService(
    prisma,
    new StoreScopeService(prisma),
    { record: async () => undefined } as any,
    { nextRef: async (p: string, b: string) => `${p}-${b}-001` } as any,
    {
      emit: async (ids: string[], input: any) =>
        emitted.push({ to: ids.join(','), title: input.title }),
      emitToApprovers: async (storeId: string, role: Role, input: any) =>
        emitted.push({ to: storeId, role, title: input.title }),
    } as any,
  );

  return { svc, emitted, stockFindManyArgs, current: () => row };
}

describe('the picker shows another branch’s shelf, and nothing else about it', () => {
  it('asks only for that one branch’s available pieces, inside the caller’s tenant', () => {
    const where = pullableStockWhere(ORG, 'mumbai-borivali') as any;
    expect(where.organisationId).toBe(ORG);
    expect(where.storeId).toBe('mumbai-borivali');
    // Sold, reserved, melted, damaged and in-transit pieces cannot be asked
    // for, so they are not the asker's business.
    expect(where.status).toEqual({ in: ['in_stock', 'aging', 'dead_stock'] });
  });

  it('carries no price, cost or hallmark off the other branch', () => {
    const view = pullableStockView(BORIVALI_PIECE as any) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(view).sort()).toEqual(
      [
        'category', 'grossGrams', 'id', 'karat', 'metal', 'name', 'sku',
        'status', 'storeId', 'storeName', 'styleNumber',
      ].sort(),
    );
    for (const money of ['tagPrice', 'mrp', 'cost', 'huid', 'vin']) {
      expect(view[money]).toBeUndefined();
    }
  });

  it('asks the database for the identifying columns only', async () => {
    const { svc, stockFindManyArgs } = build();
    await svc.pullableStock(BANDRA_SALES, { fromStoreId: 'mumbai-borivali' });

    const select = stockFindManyArgs[0].select;
    // A `select` rather than an `include`: the money columns never leave the
    // database at all, instead of being fetched and then dropped.
    for (const money of ['tagPrice', 'mrp', 'cost', 'metalAmount', 'diamondAmount']) {
      expect(select[money]).toBeUndefined();
    }
    expect(select.sku).toBe(true);
    expect(select.grossWeight).toBe(true);
  });

  it('shows the piece to the salesperson who needs to ask for it', async () => {
    const { svc } = build();
    const rows = await svc.pullableStock(BANDRA_SALES, {
      fromStoreId: 'mumbai-borivali',
      q: 'RNG',
    });
    expect(rows).toEqual([
      expect.objectContaining({
        sku: 'RNG-001',
        storeName: 'MUMBAI BORIVALI',
        status: 'In stock',
      }),
    ]);
  });

  it('refuses a branch in another organisation', async () => {
    const { svc } = build();
    await expect(
      svc.pullableStock(BANDRA_SALES, { fromStoreId: 'other-org-branch' }),
    ).rejects.toThrow(/not in your organisation/i);
  });

  it('refuses the caller’s own branch — that is the ordinary stock list', async () => {
    // The widening exists to show what you cannot otherwise see. Your own
    // branch is not that, and serving it here would make this a second,
    // looser way to read stock you already have a screen for.
    const { svc } = build();
    await expect(
      svc.pullableStock(BANDRA_SALES, { fromStoreId: 'mumbai-bandra' }),
    ).rejects.toThrow(/already yours/i);
  });

  it('refuses the import holding pen, which has no manager to answer', async () => {
    const { svc } = build();
    await expect(
      svc.pullableStock(BANDRA_SALES, { fromStoreId: 'unassigned' }),
    ).rejects.toThrow(/holding area/i);
  });

  it('refuses a caller with no branch of their own to pull to', async () => {
    const { svc } = build();
    await expect(
      svc.pullableStock(user({ storeIds: [] }), { fromStoreId: 'mumbai-borivali' }),
    ).rejects.toThrow(/no branch/i);
  });

  it('refuses head office, which already sees every branch', async () => {
    const { svc } = build();
    await expect(
      svc.pullableStock(HEAD_OFFICE, { fromStoreId: 'mumbai-borivali' }),
    ).rejects.toThrow(/branch staff raise them/i);
  });
});

describe('raising a pull', () => {
  it('records the asking branch as the destination and the holder as the source', async () => {
    const { svc, current } = build();
    await svc.createPull(BANDRA_SALES, {
      fromStoreId: 'mumbai-borivali',
      toStoreId: 'mumbai-bandra',
      stockItemIds: ['piece-1'],
    });
    expect(current()).toMatchObject({
      initiatedBy: 'destination',
      status: 'draft',
      fromStoreId: 'mumbai-borivali',
      toStoreId: 'mumbai-bandra',
      requestedById: BANDRA_SALES.id,
    });
  });

  it('refuses to pull to a branch the asker does not work at', async () => {
    const { svc } = build();
    await expect(
      svc.createPull(BANDRA_SALES, {
        fromStoreId: 'mumbai-bandra',
        toStoreId: 'mumbai-borivali',
        stockItemIds: ['piece-1'],
      }),
    ).rejects.toThrow(/not in your scope/i);
  });

  it('goes to the holding branch, not to head office', async () => {
    const { svc, emitted, current } = build(pendingPull({ status: 'draft' }));
    await svc.submit(BANDRA_SALES, 'tr-1');

    expect(current().status).toBe('pending_source');
    // Head office is not asked to approve a movement the branch holding the
    // pieces has not agreed to yet.
    expect(emitted).toEqual([
      expect.objectContaining({ to: 'mumbai-borivali', role: 'store_manager' }),
    ]);
  });

  it('leaves a push going straight to head office, exactly as before', () => {
    expect(submitTarget('source')).toBe('submitted');
    expect(submitTarget('destination')).toBe('pending_source');
  });
});

describe('the holding branch decides', () => {
  it('accepts, and only then does it join the existing ladder', async () => {
    const { svc, emitted, current } = build();
    await svc.acceptPull(BORIVALI_MANAGER, 'tr-1');

    expect(current()).toMatchObject({
      status: 'submitted',
      sourceDecidedById: BORIVALI_MANAGER.id,
    });
    expect(emitted.some((e) => e.role === 'head_office')).toBe(true);
    // Accepting reserves nothing: the pieces stay sellable at Borivali until
    // head office approves, exactly as on a push.
    expect(current().items[0]).toMatchObject({ stockItemId: 'piece-1' });
  });

  it('refuses, and refusing is one action with a reason', async () => {
    const { svc, emitted, current } = build();
    await svc.declinePull(BORIVALI_MANAGER, 'tr-1', {
      reason: 'Promised to a customer here on Saturday',
    });

    expect(current()).toMatchObject({
      status: 'declined',
      reason: 'Promised to a customer here on Saturday',
      sourceDecidedById: BORIVALI_MANAGER.id,
    });
    // The asker is told; they are standing in front of the customer.
    expect(emitted).toEqual([
      expect.objectContaining({ to: BANDRA_SALES.id }),
    ]);
  });

  it('a refusal is final — it is not an escalation to anybody', () => {
    expect(ALLOWED_NEXT.declined).toEqual([]);
  });

  it('cannot be answered by the branch that asked', async () => {
    const { svc } = build();
    await expect(svc.acceptPull(BANDRA_MANAGER, 'tr-1')).rejects.toThrow(
      /not in your scope/i,
    );
  });

  it('cannot be answered by a salesperson at the holding branch', async () => {
    const { svc } = build();
    await expect(
      svc.acceptPull(user({ id: 'u-bori-sales', storeIds: ['mumbai-borivali'] }), 'tr-1'),
    ).rejects.toThrow(/cannot operate stock transfers/i);
  });

  it('cannot be answered by head office — it is the branch’s call, not theirs', async () => {
    const { svc } = build();
    await expect(svc.acceptPull(HEAD_OFFICE, 'tr-1')).rejects.toThrow(
      /branch operations are the store manager/i,
    );
  });

  it('cannot be self-approved by a manager who runs both branches', async () => {
    // Five people in production run more than one branch. Without this, a pull
    // would be a way to move stock between your own two branches with nobody
    // else involved.
    const { svc } = build(pendingPull({ requestedById: BOTH_BRANCHES_MANAGER.id }));
    await expect(svc.acceptPull(BOTH_BRANCHES_MANAGER, 'tr-1')).rejects.toThrow(
      /cannot approve your own/i,
    );
  });

  it('cannot self-decline either — a no on your own ask is still your own call', async () => {
    const { svc } = build(pendingPull({ requestedById: BOTH_BRANCHES_MANAGER.id }));
    await expect(
      svc.declinePull(BOTH_BRANCHES_MANAGER, 'tr-1', {}),
    ).rejects.toThrow(/cannot approve your own/i);
  });

  it('does not answer a push: that transfer was sent, not asked for', async () => {
    const { svc } = build(pendingPull({ initiatedBy: 'source', status: 'submitted' }));
    await expect(svc.acceptPull(BORIVALI_MANAGER, 'tr-1')).rejects.toThrow(
      /sent by its source/i,
    );
  });

  it('cannot answer twice', async () => {
    const { svc } = build(pendingPull({ status: 'declined' }));
    await expect(svc.acceptPull(BORIVALI_MANAGER, 'tr-1')).rejects.toThrow(
      /Cannot move transfer from declined to submitted/,
    );
  });
});

describe('the movement itself is unchanged', () => {
  it('still goes to head office, then dispatch, receive and acknowledge', () => {
    // The asking is the new part. Everything after `submitted` is the same
    // graph it was before a pull existed.
    expect(ALLOWED_NEXT.submitted).toEqual(['ho_approved', 'rejected', 'cancelled']);
    expect(ALLOWED_NEXT.ho_approved).toEqual(['dispatched', 'cancelled']);
    expect(ALLOWED_NEXT.dispatched).toEqual(['received']);
    expect(ALLOWED_NEXT.received).toEqual(['acknowledged']);
  });

  it('lets the asking branch withdraw its own pull before it moves', async () => {
    const { svc, current } = build();
    await svc.cancel(BANDRA_MANAGER, 'tr-1', { reason: 'Customer left' });
    expect(current()).toMatchObject({ status: 'cancelled', reason: 'Customer left' });
  });
});
