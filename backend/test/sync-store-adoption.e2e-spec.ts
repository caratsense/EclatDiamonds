import { SyncService } from '../src/sync/sync.service';

/**
 * Store adoption — does an incoming Gati branch claim the Eclat store that
 * already represents that shop, instead of creating a twin?
 *
 * This is the check that would have caught the go-live failure it was written
 * for. Eclat's Bandra store is named "Mumbai — Bandra"; Gati calls the same shop
 * "MUMBAI BANDRA". If they don't link, the sync creates a second Bandra, the
 * stock lands there, and the salespeople assigned to the first one open an empty
 * shop — with every total still adding up.
 *
 * No database: planAdoptions only reads Store, so a stub is enough and the
 * matching rules get exercised directly.
 */
describe('sync — linking Gati branches to existing stores', () => {
  /** Eclat's stores as set up by hand, none linked to Gati yet. */
  const ECLAT = [
    { id: 'mumbai-bandra', name: 'Mumbai — Bandra' },
    { id: 'mumbai-borivali', name: 'Mumbai - Borivali' },
    { id: 'mumbai-kala-ghoda', name: 'Mumbai - Kala Ghoda' },
    { id: 'delhi', name: 'Delhi' },
    { id: 'udaipur', name: 'Udaipur' },
    { id: 'hyderabad', name: 'Hyderabad' },
    { id: 'surat-main', name: 'Surat — Main' },
  ];

  function serviceWith(stores: { id: string; name: string; legacyId?: string }[]) {
    const prisma = {
      store: {
        findMany: async ({ where, select }: any) => {
          const unlinked = where?.legacyId === null;
          const rows = stores.filter((s) =>
            unlinked ? !s.legacyId : where?.legacyId?.not === null ? !!s.legacyId : true,
          );
          if (select?.legacyId && !select?.name) return rows.map((s) => ({ legacyId: s.legacyId }));
          return rows.map((s) => ({ id: s.id, name: s.name }));
        },
      },
    };
    // planAdoptions touches only `store`, so config/audit/provenance are stubs.
    // ProvenanceService joined the constructor when the purge's "did the customer
    // give us this?" rule moved out of SyncService into one shared place.
    return new SyncService(prisma as any, { get: () => undefined } as any, {} as any, {} as any);
  }

  /** legacyId -> the Eclat store id it would claim (or undefined). */
  async function plan(
    records: { legacyId: string; name: string }[],
    stores = ECLAT as { id: string; name: string; legacyId?: string }[],
  ) {
    const svc = serviceWith(stores);
    // planAdoptions is now org-scoped: (organisationId, records). The stub prisma
    // ignores organisationId (it filters only on legacyId), so a dummy org id
    // exercises the same name-matching logic this test covers.
    const map = await (svc as any).planAdoptions('org_eclat', records);
    const out: Record<string, string | undefined> = {};
    for (const r of records) out[r.legacyId] = map.get(r.legacyId)?.storeId;
    return out;
  }

  it('links the six real branches to the stores that already exist', async () => {
    const got = await plan([
      { legacyId: '0001000023', name: 'MUMBAI BANDRA' },
      { legacyId: '0001000025', name: 'MUMBAI BORIVALI' },
      { legacyId: '0001000026', name: 'MUMBAI KALAGHODA' },
      { legacyId: '0001000027', name: 'DELHI ROHINI' },
      { legacyId: '0001000029', name: 'UDAIPUR ASHOK NAGAR' },
    ]);
    expect(got).toEqual({
      '0001000023': 'mumbai-bandra',
      '0001000025': 'mumbai-borivali',
      // Spacing differs on both sides — "Kala Ghoda" vs "KALAGHODA".
      '0001000026': 'mumbai-kala-ghoda',
      // Gati just says which Delhi / which Udaipur.
      '0001000027': 'delhi',
      '0001000029': 'udaipur',
    });
  });

  it('gives the exact name the store, and creates the other branch separately', async () => {
    // Both of these contain the words of "Mumbai — Bandra". Only one is it.
    const got = await plan([
      { legacyId: '0001000127', name: 'MUMBAI BANDRA BROADWAY' },
      { legacyId: '0001000023', name: 'MUMBAI BANDRA' },
    ]);
    expect(got['0001000023']).toBe('mumbai-bandra');
    expect(got['0001000127']).toBeUndefined();
  });

  it('leaves a branch alone when no existing store is recognisably it', async () => {
    // "Hyderabad" shares no word with "BANJARA HILLS HYD". A human decides.
    const got = await plan([{ legacyId: '0002000168', name: 'BANJARA HILLS HYD' }]);
    expect(got['0002000168']).toBeUndefined();
  });

  it('never re-points a store that is already linked to a Gati branch', async () => {
    const stores = [{ id: 'mumbai-bandra', name: 'Mumbai — Bandra', legacyId: '0001000023' }];
    // A different Gati id with a matching name must NOT steal the linked store.
    const got = await plan([{ legacyId: '0009999999', name: 'MUMBAI BANDRA' }], stores);
    expect(got['0009999999']).toBeUndefined();
  });

  it('does not let two Gati branches claim the same store', async () => {
    const got = await plan([
      { legacyId: 'A', name: 'DELHI ROHINI' },
      { legacyId: 'B', name: 'DELHI PASCHIM VIHAR' },
    ]);
    const claimed = Object.values(got).filter(Boolean);
    expect(claimed).toEqual(['delhi']);
  });

  it('ignores a nameless row rather than matching it to everything', async () => {
    const got = await plan([{ legacyId: 'Z', name: '   ' }]);
    expect(got['Z']).toBeUndefined();
  });
});
