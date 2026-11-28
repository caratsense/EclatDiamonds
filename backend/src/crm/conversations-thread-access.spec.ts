import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ConversationsService } from './conversations.service';

/**
 * A THREAD THE LIST SHOWS CAN BE OPENED.
 *
 * The reported failure, 28 Nov: the inbox list rendered a thread and the pane
 * beside it read "Could not open thread." with a Retry. The first suspicion was
 * the obvious one — that the list's predicate and the detail's predicate had
 * drifted apart, so one of them admitted a thread the other refused. A branch
 * filter had been rewritten hours earlier (`branchClause`, the same day), which
 * made it the likeliest place for exactly that.
 *
 * It was not that. `list` is `visibility() AND branch`, `load` is `visibility()`
 * alone, so the detail door is strictly the wider of the two and cannot refuse
 * a row the list let through. These assertions are what keeps that true, for
 * every role and every state of the branch picker, because the next person to
 * add a term to one of the two will not have read this paragraph.
 *
 * They work by EVALUATING both `where` clauses against the same conversations
 * rather than comparing their shapes: two predicates can be written quite
 * differently and mean the same thing, and it is the meaning that has to agree.
 * `admits` understands only the clauses these two actually build and throws on
 * anything else, so a predicate that grows a term fails loudly here instead of
 * quietly passing a test that no longer reads it.
 */

const ORG = 'org_eclat';

/** A conversation, in the four fields these two predicates look at. */
interface Row {
  id: string;
  organisationId: string;
  audience: string;
  storeId: string | null;
}

/**
 * The threads the probes run against: one at each branch in scope, one at a
 * branch that is not, the unrouted one, a staff notice, and another tenant's.
 */
const ROWS: Row[] = [
  { id: 'c_bandra', organisationId: ORG, audience: 'customer', storeId: 'mumbai-bandra' },
  { id: 'c_borivali', organisationId: ORG, audience: 'customer', storeId: 'mumbai-borivali' },
  { id: 'c_unbranched', organisationId: ORG, audience: 'customer', storeId: null },
  { id: 'c_staff', organisationId: ORG, audience: 'staff', storeId: 'mumbai-bandra' },
  { id: 'c_hyderabad', organisationId: ORG, audience: 'customer', storeId: 'hyderabad' },
  { id: 'c_other_org', organisationId: 'org_other', audience: 'customer', storeId: 'mumbai-bandra' },
];

/** Does this scalar clause — a value, a null, or an `in` list — match the row? */
function matchesScalar(clause: unknown, actual: string | null): boolean {
  if (clause === null) return actual === null;
  if (typeof clause === 'string') return actual === clause;
  if (clause && typeof clause === 'object' && 'in' in clause) {
    const list = (clause as { in: string[] }).in;
    return actual !== null && list.includes(actual);
  }
  throw new Error(`this test cannot evaluate the clause ${JSON.stringify(clause)}`);
}

/** Does the `where` the inbox built admit this conversation? */
function admits(where: Prisma.ConversationWhereInput, row: Row): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    switch (key) {
      case 'AND':
        if (!(value as Prisma.ConversationWhereInput[]).every((term) => admits(term, row))) {
          return false;
        }
        break;
      case 'OR':
        if (!(value as Prisma.ConversationWhereInput[]).some((term) => admits(term, row))) {
          return false;
        }
        break;
      case 'id':
      case 'organisationId':
      case 'audience':
        if (!matchesScalar(value, row[key])) return false;
        break;
      case 'storeId':
        if (!matchesScalar(value, row.storeId)) return false;
        break;
      default:
        /*
         * Deliberately fatal. A silently ignored clause would make this test
         * agree with itself rather than with the inbox — teach it the new
         * clause, never delete the assertion.
         */
        throw new Error(
          `the inbox predicate grew a \`${key}\` clause that this test cannot evaluate`,
        );
    }
  }
  return true;
}

/** Everything but `prisma` and `scope` is unreachable from a list or a load. */
function inbox(prisma: unknown, scope: StoreScopeService): ConversationsService {
  const unused = undefined as never;
  return new ConversationsService(
    prisma as never,
    scope,
    unused, unused, unused, unused, unused, unused, unused,
    unused, unused, unused, unused, unused, unused, unused,
  );
}

const scope = new StoreScopeService(undefined as never);

function capturingPrisma() {
  const wheres: Prisma.ConversationWhereInput[] = [];
  const prisma = {
    conversation: {
      findMany: async (args: { where: Prisma.ConversationWhereInput }) => {
        wheres.push(args.where);
        return [];
      },
      // `load` refuses with a 404 on a null, so the stub answers with a row.
      findFirst: async (args: { where: Prisma.ConversationWhereInput }) => {
        wheres.push(args.where);
        return { id: 'found' };
      },
    },
  };
  return { prisma, wheres };
}

/** The `where` the inbox list sends to Prisma for this caller and branch. */
async function listPredicate(
  user: AuthUser,
  opts: { storeId?: string; unbranched?: boolean } = {},
): Promise<Prisma.ConversationWhereInput> {
  const { prisma, wheres } = capturingPrisma();
  await inbox(prisma, scope).list(user, opts);
  return wheres[0];
}

/**
 * The `where` the DETAIL door sends to Prisma for this caller and thread.
 *
 * Through `assertCanAccess`, which is the public door onto the same private
 * `load` that `thread()` opens with — the whole point of that door being that
 * there is one predicate, not one per caller.
 */
async function detailPredicate(
  user: AuthUser,
  conversationId: string,
): Promise<Prisma.ConversationWhereInput> {
  const { prisma, wheres } = capturingPrisma();
  await inbox(prisma, scope).assertCanAccess(user, conversationId);
  return wheres[0];
}

const headOffice: AuthUser = {
  id: 'u_ho',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: ORG,
  storeIds: ['mumbai-bandra', 'mumbai-borivali'],
  allStores: true,
};

const storeManager: AuthUser = {
  ...headOffice,
  id: 'u_sm',
  role: 'store_manager',
  allStores: false,
  storeIds: ['mumbai-bandra'],
};

const salesperson: AuthUser = {
  ...storeManager,
  id: 'u_sp',
  role: 'salesperson',
};

/** Every way into the inbox a person actually has. */
const SCENARIOS: { what: string; user: AuthUser; opts: { storeId?: string; unbranched?: boolean } }[] =
  [
    { what: 'head office on All Stores', user: headOffice, opts: { storeId: 'all' } },
    { what: 'head office with no branch sent', user: headOffice, opts: {} },
    { what: 'head office with a branch picked', user: headOffice, opts: { storeId: 'mumbai-bandra' } },
    {
      what: 'head office in the "No branch yet" queue',
      user: headOffice,
      opts: { storeId: 'mumbai-bandra', unbranched: true },
    },
    { what: 'a store manager at their branch', user: storeManager, opts: { storeId: 'mumbai-bandra' } },
    { what: 'a salesperson at their branch', user: salesperson, opts: { storeId: 'mumbai-bandra' } },
    { what: 'a salesperson with no branch sent', user: salesperson, opts: {} },
  ];

describe('the inbox list and the thread it opens agree on which threads exist', () => {
  for (const { what, user, opts } of SCENARIOS) {
    it(`opens every thread the list shows to ${what}`, async () => {
      const list = await listPredicate(user, opts);

      const listed = ROWS.filter((row) => admits(list, row));
      // Not vacuous: a scenario that lists nothing would pass the loop below
      // without ever asking the question.
      expect(listed.length).toBeGreaterThan(0);

      for (const row of listed) {
        const detail = await detailPredicate(user, row.id);
        expect({ thread: row.id, openable: admits(detail, row) }).toEqual({
          thread: row.id,
          openable: true,
        });
      }
    });
  }
});

describe('the detail door is the wider of the two, and must stay that way round', () => {
  it('still opens an unrouted thread while the branch picker is on a branch', async () => {
    /*
     * The asymmetry is deliberate, and this is the direction it has to point.
     * `branchClause` is what the reader ASKED to look at; `visibility()` is what
     * they are allowed to read. Narrowing the detail door by the branch as well
     * would break a bell notification and a link out of the customer directory
     * the moment the top bar happened to be pointed somewhere else — the thread
     * would be refused for a reason the person reading has no way to see.
     */
    const list = await listPredicate(headOffice, { storeId: 'mumbai-bandra' });
    const unrouted = ROWS.find((row) => row.id === 'c_unbranched')!;

    expect(admits(list, unrouted)).toBe(false);
    expect(admits(await detailPredicate(headOffice, unrouted.id), unrouted)).toBe(true);
  });

  it('refuses another tenant, another branch and a staff notice at both doors', async () => {
    // The things the wider door must still not open. Head office's scope is
    // every branch OF ITS OWN ORGANISATION, which is where tenant isolation
    // rides on store scope.
    const list = await listPredicate(storeManager, { storeId: 'mumbai-bandra' });

    for (const id of ['c_other_org', 'c_hyderabad', 'c_borivali', 'c_staff']) {
      const row = ROWS.find((r) => r.id === id)!;
      expect(admits(list, row)).toBe(false);
      expect(admits(await detailPredicate(storeManager, row.id), row)).toBe(false);
    }
  });
});
