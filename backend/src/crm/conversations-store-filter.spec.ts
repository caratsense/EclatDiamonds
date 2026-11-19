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

/** The extra terms `list`/`queueCounts` AND on top of the visibility rule. */
function branchTerms(where: Prisma.ConversationWhereInput) {
  const and = (where.AND ?? []) as Prisma.ConversationWhereInput[];
  return and.filter((term) => 'OR' in term && !('audience' in term));
}

describe('the inbox narrows to the branch in the top bar', () => {
  it('pins the query to that branch instead of the whole organisation', async () => {
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { storeId: 'mumbai-bandra' });

    expect(branchTerms(wheres[0])).toEqual([
      { OR: [{ storeId: 'mumbai-bandra' }, { storeId: null }] },
    ]);
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

  it('keeps threads with no branch, so the central queue never disappears', async () => {
    // An unrouted ad thread belongs to no branch — choosing one must not be the
    // thing that hides the enquiry nobody has claimed yet.
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { storeId: 'mumbai-bandra' });

    expect(branchTerms(wheres[0])[0]).toEqual({
      OR: [{ storeId: 'mumbai-bandra' }, { storeId: null }],
    });
  });
});

describe('the queue badges count the same branch the list shows', () => {
  it('narrows every count to the chosen branch', async () => {
    const { prisma, wheres } = capturingPrisma();
    await inbox(prisma, scope).queueCounts(headOffice, 'mumbai-bandra');

    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) {
      expect(branchTerms(where)).toEqual([
        { OR: [{ storeId: 'mumbai-bandra' }, { storeId: null }] },
      ]);
    }
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
