import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AdEnquiryCountsService } from './ad-enquiry-counts.service';

/**
 * ONE BRANCH'S MANAGER NEVER READS ANOTHER BRANCH'S NUMBERS.
 *
 * `ad-enquiry-counts.spec.ts` covers the grouping; nothing covered the boundary
 * around it, which is the half that cannot be noticed when it is wrong. A
 * ranking with eleven branches' enquiries in it looks exactly like a ranking
 * with one branch's — bigger numbers, same shape — so a leak here would be
 * read as a good month, not as a bug, and `ad-cost-per-enquiry` is about to put
 * money on top of these same scoped counts.
 *
 * These exercise the real `report` with the real StoreScopeService and capture
 * the SQL it sends. No database is needed to answer the two questions that
 * matter: can a branch the caller is not scoped to reach the query, and who is
 * allowed the enquiries that reached no branch at all.
 */

/** `adMetadata` is unreachable while the aggregate returns no rows. */
function counts(prisma: unknown, scope: StoreScopeService): AdEnquiryCountsService {
  return new AdEnquiryCountsService(prisma as never, scope, undefined as never);
}

function capturingPrisma(rows: unknown[] = []) {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query);
      return rows;
    },
    store: { findMany: async () => [] },
  };
  return { prisma, queries };
}

const scope = new StoreScopeService(undefined as never);

function user(role: AuthUser['role'], storeIds: string[]): AuthUser {
  return {
    id: 'u1',
    name: 'Tester',
    email: 'tester@example.com',
    role,
    organisationId: 'org_eclat',
    storeIds,
    allStores: role === 'head_office',
  } as AuthUser;
}

const manager = user('store_manager', ['mumbai-bandra']);
const areaManager = user('area_manager', ['mumbai-bandra', 'mumbai-borivali']);
const headOffice = user('head_office', ['mumbai-bandra', 'mumbai-borivali', 'indore-ratnamani']);

/** The branch ids that reached the aggregate, in the order the SQL names them. */
function branchParams(query: Prisma.Sql): string[] {
  // organisationId then `since`, then one parameter per scoped branch.
  return query.values.slice(2) as string[];
}

/** Whether the aggregate admitted threads that reached no branch. */
function admitsUnrouted(query: Prisma.Sql): boolean {
  return /"storeId"\s+IS\s+NULL/.test(query.sql);
}

describe('AdEnquiryCountsService scope', () => {
  it('asks only for the branches a store manager runs', async () => {
    const { prisma, queries } = capturingPrisma();
    const report = await counts(prisma, scope).report(manager);

    expect(queries).toHaveLength(1);
    expect(branchParams(queries[0])).toEqual(['mumbai-bandra']);
    expect(report.storeIds).toEqual(['mumbai-bandra']);
  });

  it('refuses a branch outside the caller, rather than widening to what they can see', async () => {
    const { prisma, queries } = capturingPrisma();
    await expect(
      counts(prisma, scope).report(manager, { storeId: 'mumbai-borivali' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Refused BEFORE the aggregate ran: a leak cannot be filtered out afterwards.
    expect(queries).toHaveLength(0);
  });

  it('narrows to the one branch an area manager picked, not to both of theirs', async () => {
    const { prisma, queries } = capturingPrisma();
    const report = await counts(prisma, scope).report(areaManager, { storeId: 'mumbai-borivali' });

    expect(branchParams(queries[0])).toEqual(['mumbai-borivali']);
    expect(report.storeIds).toEqual(['mumbai-borivali']);
  });

  it('gives head office every branch of its organisation and nothing beyond it', async () => {
    const { prisma, queries } = capturingPrisma();
    const report = await counts(prisma, scope).report(headOffice);

    expect(branchParams(queries[0])).toEqual([
      'mumbai-bandra',
      'mumbai-borivali',
      'indore-ratnamani',
    ]);
    expect(queries[0].values[0]).toBe('org_eclat');
    expect(report.storeIds).toHaveLength(3);
  });

  /*
   * The unrouted rule, which is the inbox's own (ConversationsService
   * branchClause): a thread at no branch belongs to nobody yet, so it fails
   * closed to head office. Without this, each of eleven managers would read the
   * same unplaced enquiries as if they were theirs, and the same thread would be
   * credited to its advert eleven times over.
   */
  it('admits enquiries that reached no branch for head office only', async () => {
    const asHo = capturingPrisma();
    const hoReport = await counts(asHo.prisma, scope).report(headOffice);
    expect(admitsUnrouted(asHo.queries[0])).toBe(true);
    expect(hoReport.includesUnrouted).toBe(true);

    for (const person of [manager, areaManager]) {
      const asStaff = capturingPrisma();
      const report = await counts(asStaff.prisma, scope).report(person);
      expect(admitsUnrouted(asStaff.queries[0])).toBe(false);
      expect(report.includesUnrouted).toBe(false);
    }
  });

  /*
   * A CHOSEN BRANCH MEANS THAT BRANCH (client, 28 Nov). Head office picking
   * Bandra must not have other people's strays added to Bandra's figures — the
   * same mistake the inbox made before `branchClause` dropped the null branch.
   */
  it('drops the unrouted column once head office picks a branch', async () => {
    const { prisma, queries } = capturingPrisma();
    const report = await counts(prisma, scope).report(headOffice, { storeId: 'mumbai-bandra' });

    expect(branchParams(queries[0])).toEqual(['mumbai-bandra']);
    expect(admitsUnrouted(queries[0])).toBe(false);
    expect(report.includesUnrouted).toBe(false);
  });

  /*
   * `all` is a real Store row the switcher sends like any other. The decorator
   * resolves it to undefined, but the DTO's `storeId` reaches this service
   * verbatim, so the service has to know the word too — otherwise head office on
   * "All Stores" would query `storeId IN ('all')` and read an empty ranking as a
   * quiet month.
   */
  it('treats "all" as the whole scope, not as a branch named all', async () => {
    const { prisma, queries } = capturingPrisma();
    const report = await counts(prisma, scope).report(headOffice, { storeId: 'all' });

    expect(branchParams(queries[0])).toHaveLength(3);
    expect(report.includesUnrouted).toBe(true);
  });

  /*
   * Somebody assigned to no branch yet (a new starter, a transfer in progress).
   * Widening them to the organisation would hand them the chain, and an empty
   * `IN ()` is a SQL error — so they read nothing, and read it without a 500.
   */
  it('reads nothing for a person with no branches, without querying', async () => {
    const { prisma, queries } = capturingPrisma();
    const report = await counts(prisma, scope).report(user('store_manager', []));

    expect(queries).toHaveLength(0);
    expect(report.storeIds).toEqual([]);
    expect(report.totals.enquiries).toBe(0);
    // Not 0%: nothing arrived, so there is no share to state.
    expect(report.totals.repliedPct).toBeNull();
  });
});
