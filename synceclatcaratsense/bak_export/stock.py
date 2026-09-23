"""Per-piece stock out of the APRSSJEP backup, in the shape POST /sync/stock takes.

Same selection as sync_sjep.extract_stock (Inward + InwardSummary 1:1 on JewelId,
+ ToneMst on MetalToneNo), narrowed to the columns syncStock actually reads, minus
cost. Read-only: the .bak is never written.

Legacy key: Inward.JewelId -> StockItem.legacyId (organisationId_legacyId upsert).
"""
import sys
from datetime import date, datetime
from decimal import Decimal

sys.path.insert(0, r'C:/Users/Shrey/AppData/Local/Temp/claude/c--Users-Shrey-OneDrive-Desktop-Eclat/b57205d8-d1f2-4b9a-b580-57dc0e6f81d1/scratchpad/bakexport')
import _reader

# Columns syncStock reads off the record, and nothing else. Cost columns (COST,
# every Tot*CostAmt, Actual*) are excluded on purpose — sale rates only.
FROM_INWARD = [
    'JewelId',            # legacy key
    'StyleId',            # -> Product
    'BranchNo',           # -> Store (branchColumnsFor('stock'))
    'JewelCode', 'InwardSKUNo',   # name / sku / karat token
    'Status', 'SaleId',   # stockStatusFromInward
    'InwardQty', 'ItemSizeId',
    'Jewelry_CertificateNo',
    'TagPrice',
    'InwardDate', 'UpdateDate', 'EntryDate',
]
FROM_SUMMARY = [
    'GrossWt', 'NetWt', 'PureWt', 'MetalLossWt',
    'TotDiaWt', 'TotDiaPc', 'TotCZWt', 'TotCZPc',
    'TotMtlAmt', 'TotDiaAmt', 'TotCZAmt', 'TotHandlingAmt', 'TotCPFAmt',
    'MRP',
]
# Dropped, with the reason, so the report does not have to guess:
DROPPED = {
    'COST': 'cost price - excluded by rule (sale rates only)',
    'ProductCode': 'NULL/blank on all 2690 rows',
    'MetalToneNo': 'NULL on all 2690 rows, so the ToneMst join yields no ToneCode/ToneFor',
    'LocationId': 'NULL on all 2690 rows',
    'FirstLocationId': 'NULL on all 2690 rows',
}


def jsonable(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, str):
        return v.strip() or None
    return v


def build():
    inward = _reader.rows('Inward')
    summary = {r['JewelId']: r for r in _reader.rows('InwardSummary')}
    tone = {r['ToneNo']: r for r in _reader.rows('ToneMst')}

    records, no_summary, toned = [], 0, 0
    for r in inward:
        if r.get('JewelId') is None:
            continue
        rec = {k: jsonable(r.get(k)) for k in FROM_INWARD if r.get(k) is not None}
        s = summary.get(r['JewelId'])
        if s is None:
            no_summary += 1
        else:
            rec.update({k: jsonable(s.get(k)) for k in FROM_SUMMARY if s.get(k) is not None})
        t = tone.get(r.get('MetalToneNo'))
        if t:  # never fires on this backup: MetalToneNo is NULL throughout
            toned += 1
            rec['ToneCode'] = jsonable(t.get('ToneCode'))
            rec['ToneFor'] = jsonable(t.get('ToneFor'))
        records.append(rec)

    meta = {
        'source_tables': ['Inward', 'InwardSummary', 'ToneMst'],
        'legacy_id_field': 'JewelId',
        'endpoint': 'POST /sync/stock',
        'join': 'Inward LEFT JOIN InwardSummary ON JewelId LEFT JOIN ToneMst ON MetalToneNo=ToneNo',
        'rows_without_summary': no_summary,
        'rows_with_tone': toned,
        'dropped_columns': DROPPED,
        'note': 'Sale side only. No COST / Tot*CostAmt / Actual* column is emitted.',
    }
    return records, meta


def check(records):
    """The mapping is only worth shipping if these hold."""
    assert records, 'no records'
    ids = [r['JewelId'] for r in records]
    assert all(ids), 'a record has no JewelId'
    assert len(set(ids)) == len(ids), 'duplicate JewelId — upsert would collide'
    # The fields the shop will look at first must carry real values, not None.
    for f in ('StyleId', 'Status', 'InwardSKUNo', 'JewelCode', 'MRP', 'GrossWt', 'NetWt', 'InwardDate'):
        have = sum(1 for r in records if r.get(f) is not None)
        assert have == len(records), f'{f} missing on {len(records) - have} rows'
    # Sale rates only: no cost column may have leaked in.
    banned = [k for r in records[:50] for k in r if 'COST' in k.upper() or k == 'COST']
    assert not banned, f'cost columns leaked: {sorted(set(banned))}'
    import json
    json.dumps(records)  # every value must serialise


if __name__ == '__main__':
    records, meta = build()
    check(records)
    print(_reader.write('stock', records, meta), len(records), 'records')
