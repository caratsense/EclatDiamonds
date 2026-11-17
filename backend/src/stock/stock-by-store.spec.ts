import { StockByStoreService, STOCK_SOURCES, STOCK_SOURCE_LABELS } from './stock-by-store.service';

/**
 * The four facts the client's notes insist are different, and the one
 * distinction the inventory screens were getting wrong.
 *
 * From the meeting: "A record's data source, its original stock location, its
 * current store and its transfer destination are different facts. Do not
 * combine these into one 'source' field." And separately: "Distinguish
 * confirmed zero stock from no data received."
 *
 * These assert the pure parts — the source filter and the labels — without a
 * database. The grouping itself is exercised against production data in the
 * audit, which is reported separately.
 */
describe('stock source classification', () => {
  const svc = new StockByStoreService(
    null as never,
    null as never,
  );

  it('labels every source it can report', () => {
    for (const s of STOCK_SOURCES) expect(STOCK_SOURCE_LABELS[s]).toBeTruthy();
  });

  describe('a source filter asks about provenance, not location', () => {
    it('gati means the piece carries a Gati identifier', () => {
      // `legacyId` IS Gati's Inward.JewelId. It says nothing about which store
      // holds the piece now, which is the conflation being avoided.
      expect(svc.sourceWhere('gati')).toEqual({ legacyId: { not: null } });
    });

    it('website means a variant link and no Gati identifier', () => {
      expect(svc.sourceWhere('website')).toEqual({ variantId: { not: null }, legacyId: null });
    });

    it('manual means neither', () => {
      expect(svc.sourceWhere('manual')).toEqual({ legacyId: null, variantId: null });
    });

    it('import returns nothing, because nothing records an import batch yet', () => {
      /*
       * The honest answer. StockItem has no import-batch column, so there is
       * no way to tell an imported piece from any other. Matching everything
       * would be worse than matching nothing: a filter that silently returns
       * unrelated rows is how somebody concludes the import worked.
       */
      const where = svc.sourceWhere('import') as { id: string };
      expect(where.id).toContain('no_import_marker');
    });
  });

  describe('no data is not zero stock', () => {
    // The specific failure the client named: a store that never synced looked
    // exactly like a store that had sold everything.
    const state = (storeId: string, everRecorded: number) =>
      (svc as unknown as {
        stateFor(id: string, n: number): string;
      }).stateFor(storeId, everRecorded);

    it('a store that never received a record is no_data', () => {
      expect(state('surat-main', 0)).toBe('no_data');
    });

    it('a store with records but nothing in stock is still synced', () => {
      // It sold out. That is a real, confirmed zero and must read differently
      // from a store nothing ever arrived for.
      expect(state('mumbai-bandra', 544)).toBe('synced');
    });

    it('the unassigned holding pen is neither', () => {
      // 3,512 pieces in production sit here. Calling it a store with stock
      // would put unmapped inventory on a branch that never saw it.
      expect(state('unassigned', 3512)).toBe('unmapped_holding');
    });
  });
});
