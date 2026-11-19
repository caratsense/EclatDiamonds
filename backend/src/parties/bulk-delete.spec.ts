import { Role } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { PartiesService } from './parties.service';

/**
 * Deleting the customers somebody ticked.
 *
 * The client, 19 Nov: "There is no bulk delete option in customers. There
 * should be an option to select multiple and then delete it."
 *
 * The rules are NOT new, and that is the whole point of these tests: a customer
 * synced from Gati comes straight back on the next sync, and a customer with
 * any history takes their sales and ledger with them. One at a time those
 * refusals already held; fifty at a time they must hold identically, and the
 * reply has to say which customer was refused and why — a bare "41 of 50"
 * leaves a manager re-ticking rows to find the nine that survived.
 */

/** Every record kind `partyHistory` counts, so one stub can answer all of them. */
const HISTORY_MODELS = [
  'sale', 'ledgerEntry', 'payment', 'quote', 'lead', 'conversation', 'checkIn',
  'schemeMember', 'returnRecord', 'loyaltyAccount', 'customOrder',
  'manufacturingOrder', 'feedbackRequest', 'callLog', 'task', 'leadNote',
] as const;

type HistoryModel = (typeof HISTORY_MODELS)[number];

interface Row {
  id: string;
  name: string;
  legacyId: string | null;
  storeId: string | null;
  /** What this customer holds, e.g. `{ quote: 2 }`. Absent means nothing. */
  history?: Partial<Record<HistoryModel, number>>;
}

const HEAD_OFFICE: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@nibhana.in',
  role: Role.head_office,
  organisationId: 'org1',
  storeIds: ['surat-main', 'mumbai-bandra'],
  allStores: true,
};

/**
 * A Prisma stand-in holding the rows in memory. `deleted` is what the service
 * actually destroyed, which is the assertion that matters: a reported refusal
 * that still deleted the row would pass a test on the response alone.
 */
function fakePrisma(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deleted: string[] = [];

  const counters = Object.fromEntries(
    HISTORY_MODELS.map((model) => [
      model,
      {
        count: ({ where }: { where: { partyId: string } }) =>
          Promise.resolve(byId.get(where.partyId)?.history?.[model] ?? 0),
      },
    ]),
  );

  return {
    deleted,
    prisma: {
      ...counters,
      party: {
        findMany: ({
          where,
        }: {
          where: { id: { in: string[] }; organisationId: string };
        }) =>
          Promise.resolve(
            where.id.in
              .map((id) => byId.get(id))
              .filter((r): r is Row => !!r && where.organisationId === 'org1')
              .map((r) => ({
                id: r.id,
                name: r.name,
                types: ['customer'],
                legacyId: r.legacyId,
                storeId: r.storeId,
              })),
          ),
        delete: ({ where }: { where: { id: string } }) => {
          deleted.push(where.id);
          byId.delete(where.id);
          return Promise.resolve({ id: where.id });
        },
      },
    },
  };
}

function serviceFor(rows: Row[]) {
  const { prisma, deleted } = fakePrisma(rows);
  const audited: { action: string; entityId: string }[] = [];
  const service = new PartiesService(
    prisma as never,
    { orgFilter: (u: AuthUser) => ({ organisationId: u.organisationId }) } as never,
    { record: (_u: AuthUser, e: { action: string; entityId: string }) => {
        audited.push({ action: e.action, entityId: e.entityId });
        return Promise.resolve();
      } } as never,
    null as never,
  );
  return { service, deleted, audited };
}

describe('bulk delete of customers', () => {
  it('refuses a customer synced from Gati, and says why', async () => {
    const { service, deleted } = serviceFor([
      { id: 'p1', name: 'Rajesh Agarwal', legacyId: '4412', storeId: 'surat-main' },
    ]);

    const result = await service.removeMany(HEAD_OFFICE, ['p1']);

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'p1',
        name: 'Rajesh Agarwal',
        reason: 'Synced from Gati — a delete would come straight back. Archive instead.',
      },
    ]);
    // Nothing was destroyed. The reason is not a warning after the fact.
    expect(deleted).toEqual([]);
  });

  it('refuses a customer with history, naming what they hold', async () => {
    const { service, deleted } = serviceFor([
      {
        id: 'p2',
        name: 'Meera Shah',
        legacyId: null,
        storeId: 'surat-main',
        history: { sale: 2, payment: 1 },
      },
    ]);

    const result = await service.removeMany(HEAD_OFFICE, ['p2']);

    expect(result.deleted).toEqual([]);
    expect(result.skipped[0].reason).toBe('2 sales, 1 payments on record. Archive instead.');
    expect(deleted).toEqual([]);
  });

  it('deletes a customer who holds nothing', async () => {
    const { service, deleted, audited } = serviceFor([
      { id: 'p3', name: '♥♥♥', legacyId: null, storeId: 'surat-main' },
    ]);

    const result = await service.removeMany(HEAD_OFFICE, ['p3']);

    expect(result.deleted).toEqual([{ id: 'p3', name: '♥♥♥' }]);
    expect(result.skipped).toEqual([]);
    expect(deleted).toEqual(['p3']);
    // Audited per customer, exactly as the single delete is.
    expect(audited).toEqual([{ action: 'crm.contact_deleted', entityId: 'p3' }]);
  });

  it('reports both in one call, rather than failing the whole selection', async () => {
    const { service, deleted } = serviceFor([
      { id: 'p1', name: 'Rajesh Agarwal', legacyId: '4412', storeId: 'surat-main' },
      { id: 'p2', name: 'Meera Shah', legacyId: null, storeId: 'surat-main', history: { quote: 1 } },
      { id: 'p3', name: '♥♥♥', legacyId: null, storeId: 'surat-main' },
    ]);

    const result = await service.removeMany(HEAD_OFFICE, ['p1', 'p2', 'p3']);

    expect(result.requested).toBe(3);
    expect(result.deleted).toEqual([{ id: 'p3', name: '♥♥♥' }]);
    expect(result.skipped.map((s) => s.name)).toEqual(['Rajesh Agarwal', 'Meera Shah']);
    // The one that could go, went. One refusal does not undo the others.
    expect(deleted).toEqual(['p3']);
  });

  it('skips a customer at a branch outside the caller\'s scope', async () => {
    const { service, deleted } = serviceFor([
      { id: 'p4', name: 'Priya Jain', legacyId: null, storeId: 'delhi-ho' },
    ]);

    const result = await service.removeMany(HEAD_OFFICE, ['p4']);

    expect(result.skipped[0].reason).toBe('Belongs to a branch outside your scope.');
    expect(deleted).toEqual([]);
  });

  it('reports an id it cannot see as gone, without saying whose it was', async () => {
    const { service } = serviceFor([]);

    const result = await service.removeMany(HEAD_OFFICE, ['someone-elses-id']);

    // Another tenant's customer must read exactly like a deleted one, or the
    // reply becomes a way to ask whether an id exists.
    expect(result.skipped).toEqual([
      { id: 'someone-elses-id', name: null, reason: 'No longer in the system.' },
    ]);
  });

  it('counts a duplicated id once', async () => {
    const { service, deleted } = serviceFor([
      { id: 'p3', name: '♥♥♥', legacyId: null, storeId: 'surat-main' },
    ]);

    const result = await service.removeMany(HEAD_OFFICE, ['p3', 'p3']);

    expect(result.requested).toBe(1);
    expect(deleted).toEqual(['p3']);
  });

  it('refuses an empty selection', async () => {
    const { service } = serviceFor([]);
    await expect(service.removeMany(HEAD_OFFICE, ['  '])).rejects.toThrow(
      'Pick the customers to remove.',
    );
  });
});
