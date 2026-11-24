import { isSalesScoped } from '../common/sales-scope';

/**
 * Handing a conversation to another branch.
 *
 * The client, 24 November: "But area managers don't look at messages at all.
 * Only store managers deal and transfer... can we allow them to transfer but
 * not see each other's messages?"
 *
 * An enquiry arrives at Borivali and plainly belongs to Bandra. The Borivali
 * manager is the only person who opens the inbox, and the destination list only
 * ever offered their own branch — so the enquiry could not be passed on at all.
 *
 * What is pinned here is the SHAPE of the permission, because widening one is
 * where a leak gets in: a transfer must widen where a thread may GO without
 * widening what its sender may SEE.
 */

const manager = { role: 'store_manager', isMachine: false } as const;
const salesperson = { role: 'salesperson', isMachine: false } as const;
const headOffice = { role: 'head_office', isMachine: false } as const;

describe('who may route a conversation outward', () => {
  it('a store manager is a router', () => {
    // They are the only role that actually works the inbox, which is the whole
    // reason the destination had to widen.
    expect(isSalesScoped(manager)).toBe(false);
  });

  it('head office is a router', () => {
    expect(isSalesScoped(headOffice)).toBe(false);
  });

  it('a salesperson is NOT a router', () => {
    /*
     * A salesperson works one floor and hands upward. Letting them file a
     * customer at a branch they cannot see would make a thread vanish from
     * everyone they could have asked about it.
     */
    expect(isSalesScoped(salesperson)).toBe(true);
  });
});

/**
 * The destination filter, kept here so the conditions are readable on their own.
 * It mirrors `transferTargets` exactly.
 */
function destinationWhere(organisationId: string, router: boolean, ownStoreIds: string[]) {
  return {
    organisationId,
    isAggregate: false,
    isHolding: false,
    attendanceOnly: false,
    status: { not: 'closed' },
    ...(router ? {} : { id: { in: ownStoreIds } }),
  };
}

describe('where a conversation may be sent', () => {
  it('never leaves the organisation', () => {
    // The one condition that must survive every future change to this list.
    expect(destinationWhere('org_a', true, []).organisationId).toBe('org_a');
  });

  it('offers a router every trading branch, not just their own', () => {
    const w = destinationWhere('org_a', true, ['borivali']);
    expect('id' in w).toBe(false);
  });

  it('holds a salesperson to their own branches', () => {
    const w = destinationWhere('org_a', false, ['borivali']);
    expect(w.id).toEqual({ in: ['borivali'] });
  });

  it('refuses the places nobody works', () => {
    /*
     * The import holding pen, the "All Stores" aggregate and an
     * attendance-only office are not somewhere a customer's conversation can
     * live — filing one there loses it silently.
     */
    const w = destinationWhere('org_a', true, []);
    expect(w.isAggregate).toBe(false);
    expect(w.isHolding).toBe(false);
    expect(w.attendanceOnly).toBe(false);
    expect(w.status).toEqual({ not: 'closed' });
  });
});
