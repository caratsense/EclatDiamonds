"""products: StyleMst (+StyleMstSummary 1:1, +MainProduct group name) -> POST /sync/products.

Same selection as sync_sjep.extract_items(), minus SELECT *: the endpoint takes raw
legacy column names (syncProducts reads r.StyleId, r.StyleCode, r.MRP, ...), so the
payload IS the legacy row — but whitelisted, because StyleMst/StyleMstSummary carry
COST, ActualCost and every *CostAmt twin and those must never leave the building.

Legacy key: StyleId (upsert on organisationId_legacyId).
Read-only; writes bakexport/products.json and nothing else.
"""
import sys, os, re
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader

# Sale-side only. Cost columns (COST, ActualCost, *CostAmt, CostRate) are deliberately absent.
STYLE_FIELDS = ['StyleId', 'StyleCode', 'StyleSKUNo', 'GrpNo', 'BestSeller']
SUMMARY_FIELDS = ['GrossWt', 'NetWt', 'MRP', 'TotDiaWt', 'TotDiaPc', 'TotDiaAmt', 'TotMtlAmt']


def num(v):
    return float(v) if isinstance(v, Decimal) else v


def build():
    styles = _reader.rows('StyleMst')
    summary = {r['StyleId']: r for r in _reader.rows('StyleMstSummary')}
    # The shop's own product group. StyleCode's 2-letter prefix classifies most rows
    # server-side; GrpName is what saves the ~10% whose code prefix it cannot read.
    group = {r['GrpNo']: r['GrpName'] for r in _reader.rows('MainProduct')}

    records, skipped, no_summary = [], 0, 0
    for s in styles:
        if s.get('StyleId') is None:
            skipped += 1
            continue
        rec = {f: num(s.get(f)) for f in STYLE_FIELDS if s.get(f) is not None}
        sm = summary.get(s['StyleId'])
        if sm is None:
            no_summary += 1
        else:
            rec.update({f: num(sm[f]) for f in SUMMARY_FIELDS if sm.get(f) is not None})
        name = group.get(s.get('GrpNo'))
        if name:
            rec['GrpName'] = name
        records.append(rec)
    return records, skipped, no_summary


def main():
    records, skipped, no_summary = build()
    karat = sum(1 for r in records if re.search(r'-(\d{1,2})\s*KT?-', str(r.get('StyleSKUNo') or ''), re.I))
    meta = {
        'source': 'APRSSJEP.bak (APRS-SJEP-2606081711), read-only page scan',
        'tables': {
            'StyleMst': len(_reader.rows('StyleMst')),
            'StyleMstSummary': len(_reader.rows('StyleMstSummary')),
            'MainProduct': len(_reader.rows('MainProduct')),
        },
        'legacyIdField': 'StyleId',
        'endpoint': 'POST /sync/products (SyncBatchDto: raw legacy rows)',
        'skippedNoStyleId': skipped,
        'stylesWithoutSummary': no_summary,
        'karatReadableFromSKU': f'{karat}/{len(records)}',
        'mrpNonZero': sum(1 for r in records if float(r.get('MRP') or 0) > 0),
        'omitted': {
            'cost columns': 'COST/ActualCost/*CostAmt/CostRate - sale rates only',
            'ToneCode,ToneFor': 'StyleMst.MetalToneNo is NULL on all 753 rows, so the '
                                'ToneMst join the connector does yields nothing; metal '
                                'comes from the -14KT- token in StyleSKUNo alone',
            'ModelWt,TagPrice,EndClientPrice,WebDescription': 'empty/zero on every row',
            'TotCZWt,TotCZPc,TotCZAmt,TotHandlingAmt': 'zero on every row',
            'sizes (SizeMst) and StyleMstDetail lines': 'POST /sync/products accepts neither',
        },
    }
    out = _reader.write('products', records, meta)
    print(f'{len(records)} records -> {out}')
    return records


def check(records):
    """Smallest thing that fails if the join or the whitelist breaks."""
    assert len(records) == 753, len(records)
    assert all(r.get('StyleId') is not None for r in records), 'legacy key missing'
    assert len({r['StyleId'] for r in records}) == len(records), 'duplicate StyleId'
    assert all('GrossWt' in r for r in records), 'summary join lost weights'
    banned = re.compile(r'cost', re.I)
    assert not any(banned.search(k) for r in records for k in r), 'cost field leaked'


if __name__ == '__main__':
    check(main())
    print('check ok')
