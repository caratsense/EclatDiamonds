import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ConversationsService } from './conversations.service';

/**
 * The inbox can be read past its first page.
 *
 * The reported failure, 24 Nov: "are every convo visible here, like each and
 * every? I don't think so, as last I can see is of Saturday." She was right.
 * The list took fifty threads and the screen had no control that asked for the
 * fifty-first — Saturday was simply where row fifty fell, and every
 * conversation older than it was unreachable.
 *
 * The cursor is the thing worth a test. A query parameter that is accepted,
 * typed, and then never reaches the query is a bug that passes every check and
 * shows up as "the button does nothing" — the broadcast filter failed exactly
 * that way three weeks ago. So these capture the real `findMany` arguments.
 */

function inbox(prisma: unknown, scope: StoreScopeService): ConversationsService {
  const unused = undefined as never;
  return new ConversationsService(
    prisma as never,
    scope,
    unused, unused, unused, unused, unused, unused, unused,
    unused, unused, unused, unused, unused, unused, unused,
  );
}

type FindManyArgs = Prisma.ConversationFindManyArgs;

function capturingPrisma(rows: unknown[] = []) {
  const calls: FindManyArgs[] = [];
  const prisma = {
    conversation: {
      findMany: async (args: FindManyArgs) => {
        calls.push(args);
        return rows;
      },
    },
  };
  return { prisma, calls };
}

const scope = new StoreScopeService(undefined as never);

const headOffice: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['mumbai-bandra'],
  allStores: true,
};

describe('paging through the inbox', () => {
  it('asks for the first page with no cursor at all', async () => {
    const { prisma, calls } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, {});
    expect(calls[0].cursor).toBeUndefined();
    expect(calls[0].skip).toBeUndefined();
    expect(calls[0].take).toBe(50);
  });

  it('starts the next page BELOW the last thread already shown', async () => {
    const { prisma, calls } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { cursor: 'conv_50' });
    // `skip: 1` matters as much as the cursor: without it every page repeats
    // its own first row, which reads as the list being stuck.
    expect(calls[0].cursor).toEqual({ id: 'conv_50' });
    expect(calls[0].skip).toBe(1);
  });

  it('orders by recency with the id as the tiebreak, so a cursor is unambiguous', async () => {
    const { prisma, calls } = capturingPrisma();
    await inbox(prisma, scope).list(headOffice, { cursor: 'conv_50' });
    // Two threads can share a lastMessageAt to the millisecond — a broadcast
    // writes a row for everybody it reaches. Ordering on that alone would make
    // "the one after this id" a question the database could answer two ways.
    expect(calls[0].orderBy).toEqual([{ lastMessageAt: 'desc' }, { id: 'desc' }]);
  });

  it('keeps the page size the caller asked for, within the cap', async () => {
    const { prisma, calls } = capturingPrisma();
    const service = inbox(prisma, scope);
    await service.list(headOffice, { limit: 25, cursor: 'conv_1' });
    expect(calls[0].take).toBe(25);
    // The cap is what stops a cursor walk being turned into "fetch everything".
    await service.list(headOffice, { limit: 5000 });
    expect(calls[1].take).toBe(200);
  });
});
