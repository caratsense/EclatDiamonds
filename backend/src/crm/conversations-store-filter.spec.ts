import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ConversationsService } from './conversations.service';

/**
 * The inbox honours the branch in the top bar.
 *
 * The reported failure: "when I'm selecting Mumbai Bandra I'm also getting
 * Borivali conversations". The list read `?storeId` and nothing else, while the
 * UI has only ever sent the branch as the `X-Store-Id` header — so for head
 * office, whose scope is every branch, the picker did nothing at all.
 *
 * These exercise the real `list` and `queueCounts` with the real
 * StoreScopeService, capturing the `where` each sends to Prisma. A database is
 * not needed to answer the question that matters: does the branch reach the
 * query, and can it ever reach a branch the caller is not scoped to.
 */

/** Everything but `prisma` and `scope` is unreachable from a list. */
function inbox(prisma: unknown, scope: StoreScopeService): ConversationsService {
  const unused = undefined as never;
  return new ConversationsService(
    prisma as never,
    scope,
    unused, unused, unused, unused, unused, unused, unused,
    unused, unused, unused, unused, unused, unused, unused,
  );
}

function capturingPrisma() {
  const wheres: Prisma.ConversationWhereInput[] = [];
  const prisma = {
    conversation: {
      findMany: async (args: { where: Prisma.ConversationWhereInput }) => {
        wheres.push(args.where);
        return [];
      },
      count: async (args: { where: Prisma.ConversationWhereInput }) => {
        wheres.push(args.where);
        return 0;
      },
    },
    // queueCounts batches its counts; the stub just runs them.
    $transaction: (ops: Promise<number>[]) => Promise.all(ops),
  };
  return { prisma, wheres };
}

const scope = new StoreScopeService(undefined as never);

const headOffice: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['mumbai-bandra', 'mumbai-borivali'],
  allStores: true,
};

/**
 * The branch narrowing `list`/`queueCounts` AND on top of the visibility rule.
 *
 * Identified by carrying a `storeId` and no `audience`: the visibility clause
 * always names the audience, and the per-queue terms (`status`, `handling`, …)
 * never name a store.
 */
function branchTerms(where: Prisma.ConversationWhereInput) {
  const and = (where.AND ?? []) as Prisma.ConversationWhereInput[];
  return and.filter((term) => 'storeId' in term && !('audience' in term));
}

describe('the inbox narrows to the branch in the top bar', () => {
  it('pins the query to that branch instead of the whole organisation', async () => {
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { storeId: 'mumbai-bandra' });

    expect(branchTerms(wheres[0])).toEqual([{ storeId: 'mumbai-bandra' }]);
  });

  it('adds nothing when the switcher is on "All Stores"', async () => {
    // The aggregate's id is the literal `all`. It means "everything in my
    // scope", which the visibility rule already expresses.
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { storeId: 'all' });

    expect(branchTerms(wheres[0])).toEqual([]);
  });

  it('refuses a branch the caller is not scoped to, rather than answering it', async () => {
    const { prisma } = capturingPrisma();
    const manager: AuthUser = {
      ...headOffice,
      role: 'store_manager',
      allStores: false,
      storeIds: ['mumbai-bandra'],
    };

    await expect(inbox(prisma, scope).list(manager, { storeId: 'mumbai-borivali' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('does not admit the unbranched threads alongside the branch', async () => {
    /*
     * Client, 28 Nov: picking Mumbai Bandra still listed threads labelled "No
     * store yet". The clause deliberately ORed `storeId: null` in, so every
     * unrouted enquiry appeared in all eleven branch inboxes at once. A branch
     * means that branch; the unbranched are reachable through the queue below.
     */
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { storeId: 'mumbai-bandra' });

    const terms = branchTerms(wheres[0]);
    expect(terms).toHaveLength(1);
    expect(terms[0]).not.toHaveProperty('OR');
    expect(terms[0].storeId).toBe('mumbai-bandra');
  });
});

describe('the threads that belong to no branch are still reachable', () => {
  it('lists exactly the unbranched ones, whatever the top bar is pointed at', async () => {
    // The branch is ignored on purpose: a thread at no branch cannot also be at
    // Bandra, so honouring the picker here would return nothing at all.
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, {
      storeId: 'mumbai-bandra',
      unbranched: true,
    });

    expect(branchTerms(wheres[0])).toEqual([{ storeId: null }]);
  });

  it('refuses the queue to anyone below head office', async () => {
    // An unrouted thread belongs to nobody yet, so it is head office's to
    // triage — the same rule the customer directory follows. Refused rather
    // than quietly answered, because a query parameter is a request.
    const { prisma } = capturingPrisma();
    const manager: AuthUser = {
      ...headOffice,
      role: 'store_manager',
      allStores: false,
      storeIds: ['mumbai-bandra'],
    };

    await expect(
      inbox(prisma, scope).list(manager, { storeId: 'mumbai-bandra', unbranched: true }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('the queue badges count the same branch the list shows', () => {
  it('narrows every count to the chosen branch', async () => {
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).queueCounts(headOffice, 'mumbai-bandra');

    // The "no branch yet" badge is the one count a branch cannot narrow — it
    // has its own expectation below.
    const branchCounts = wheres.filter(
      (where) => !branchTerms(where).some((term) => term.storeId === null),
    );
    expect(branchCounts.length).toBeGreaterThan(0);
    for (const where of branchCounts) {
      expect(branchTerms(where)).toEqual([{ storeId: 'mumbai-bandra' }]);
    }
  });

  it('counts the unbranched queue outside the branch, so the badge is never a zero', async () => {
    /*
     * The badge and the list must say the same thing, and they share
     * `branchClause` for exactly that reason. ANDing the chosen branch onto a
     * queue of threads that have no branch would count zero every time a
     * branch was picked, and the only route to the unrouted enquiries would
     * look empty.
     */
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).queueCounts(headOffice, 'mumbai-bandra');

    const unbranched = wheres.filter((where) =>
      branchTerms(where).some((term) => term.storeId === null),
    );
    expect(unbranched).toHaveLength(1);
    expect(branchTerms(unbranched[0])).toEqual([{ storeId: null }]);
  });

  it('offers no unbranched count to a store manager', async () => {
    // Nobody is told how much work sits in a queue they may not open.
    const { prisma } = capturingPrisma();
    const manager: AuthUser = {
      ...headOffice,
      role: 'store_manager',
      allStores: false,
      storeIds: ['mumbai-bandra'],
    };

    const counts = await inbox(prisma, scope).queueCounts(manager, 'mumbai-bandra');
    expect(counts).not.toHaveProperty('unbranched');
  });

  it('refuses a branch outside the scope, like the list does', async () => {
    const { prisma } = capturingPrisma();
    const manager: AuthUser = {
      ...headOffice,
      role: 'store_manager',
      allStores: false,
      storeIds: ['mumbai-bandra'],
    };

    await expect(inbox(prisma, scope).queueCounts(manager, 'mumbai-borivali')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
