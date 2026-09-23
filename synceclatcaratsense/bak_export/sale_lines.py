"""sale-lines out of APRSSJEP.bak, in the shape POST /sync/sale-lines eats.

Grain: one row per (JewelTransId, JewelId) = one piece on one bill.
  JewelTransInward        (3275) — the line
  JewelTransInwardSummary (3275) — its weight/amount rollup, 1:1 on the same key
Same pair sync_sjep.py:extract_sale_lines() uses. JewelTransInwardDetail (14507)
is the component breakdown *under* a line (metal/stone/labour rows); it rolls up
into Summary, which is what the handler reads — so it is not the line grain.

syncSaleLines() reads exactly: JewelTransId, JewelId, SrNo, NetWt, TotMtlAmt,
TotHandlingAmt, TotDiaAmt, DiscountAmt, MRP — and upserts on
legacyId = "<JewelTransId>:<JewelId>:<SrNo|0>". Nothing else is emitted.

Read-only. No network.
"""
import sys, os
from datetime import date, datetime
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader

# Handler field -> where it lives. Inward wins on a name collision (MRP), same as
# the connector's summary merge, which only fills columns the line lacks.
FIELDS = ('JewelTransId', 'JewelId', 'SrNo', 'NetWt', 'TotMtlAmt',
          'TotHandlingAmt', 'TotDiaAmt', 'DiscountAmt', 'MRP',
          # NOT read by syncSaleLines, carried so the line reconciles. On this
          # install the line total closes exactly as
          #   MRP = TotMtlAmt + TotDiaAmt + TotCPFAmt + TotImiAmt + TotXchgAmt
          # TotHandlingAmt is 0.00 on all 3275 rows — the making/value-addition
          # charge is TotCPFAmt — and TotDiaAmt alone misses imitation stones
          # (TotImiAmt) and exchanged material (TotXchgAmt). Mapped as-is,
          # makingAmount imports as 0 and stoneAmount is short on 894 lines.
          'TotCPFAmt', 'TotImiAmt', 'TotXchgAmt')

# Sale-side documents only. JWPH/BJWPH are supplier purchase invoices — their
# line MRP is what the shop PAID, i.e. purchase pricing, which must not be
# emitted. Doc kinds per backend sync.util.ts:docTypeFromTranType.
KEEP_TRANTYPES = {'JWSL': 'sale', 'BJWSL': 'sale', 'JWPRM': 'proforma',
                  'JWBAP': 'branch_transfer', 'JWBAI': 'branch_transfer'}
DROP_TRANTYPES = {'JWPH', 'BJWPH'}  # purchase


def jsonable(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def build():
    lines = _reader.rows('JewelTransInward')
    summaries = _reader.rows('JewelTransInwardSummary')
    sales = _reader.rows('JewelTrans')

    by_key = {(s.get('JewelTransId'), s.get('JewelId')): s for s in summaries}
    header = {s.get('JewelTransId'): s for s in sales}

    records, orphans, unmatched, mrp_differs = [], 0, 0, 0
    import collections
    kept, dropped = collections.Counter(), collections.Counter()
    for l in lines:
        tid, jid = l.get('JewelTransId'), l.get('JewelId')
        if tid is None or jid is None:
            orphans += 1
            continue
        h = header.get(tid)
        if h is None:
            orphans += 1          # line whose bill is not in JewelTrans
            continue
        tt = str(h.get('TranType') or '').upper()
        if tt not in KEEP_TRANTYPES:
            dropped[tt] += 1      # purchase invoice / unknown doc kind
            continue
        kept[KEEP_TRANTYPES[tt]] += 1
        s = by_key.get((tid, jid))
        if s is None:
            unmatched += 1
        merged = dict(s or {})
        merged.update(l)          # line beats summary on shared names (MRP)
        if s and s.get('MRP') is not None and l.get('MRP') is not None \
                and s['MRP'] != l['MRP']:
            mrp_differs += 1
        records.append({k: jsonable(merged[k]) for k in FIELDS if merged.get(k) is not None})

    meta = {
        'source_tables': ['JewelTransInward', 'JewelTransInwardSummary', 'JewelTrans'],
        'legacy_id': 'JewelTransId:JewelId:SrNo (built server-side by syncSaleLines)',
        'lines_read': len(lines),
        'dropped_no_header_or_key': orphans,
        'no_summary_row': unmatched,
        'mrp_line_vs_summary_differs': mrp_differs,
        'distinct_bills': len({r['JewelTransId'] for r in records}),
        'kept_by_doc_type': dict(kept),
        'dropped_purchase_lines_by_trantype': dict(dropped),
        'note': 'MRP taken from JewelTransInward (line), as extract_sale_lines merges; '
                'sum(line MRP) == JewelTrans.GrossAmount on every kept bill. '
                'Sale-side only: purchase-invoice (JWPH/BJWPH) lines are dropped, and no '
                'cost/margin column is emitted. TotHandlingAmt is 0.00 on all 3275 rows of '
                'this install: the making/value-addition charge is TotCPFAmt. TotCPFAmt, '
                'TotImiAmt and TotXchgAmt are carried but NOT read by syncSaleLines, so as '
                'mapped today makingAmount imports as 0 and stoneAmount omits imitation '
                'stones and exchange. MRP = TotMtlAmt+TotDiaAmt+TotCPFAmt+TotImiAmt+TotXchgAmt.',
    }
    return records, meta


def check(records):
    """One runnable check: keys present + unique, and the money is not all None."""
    keys = [(r.get('JewelTransId'), r.get('JewelId'), r.get('SrNo', 0)) for r in records]
    assert records, 'no records'
    assert all(k[0] is not None and k[1] is not None for k in keys), 'missing legacy key part'
    assert len(set(keys)) == len(keys), 'legacy id would collide'
    assert sum(1 for r in records if r.get('MRP')) > len(records) // 2, 'MRP mostly empty'
    assert sum(1 for r in records if r.get('NetWt')), 'NetWt empty everywhere'
    # the money adds up: metal + stone + value addition + exchange == line total
    closed = sum(1 for r in records
                 if abs(r.get('MRP', 0) - r.get('TotMtlAmt', 0) - r.get('TotDiaAmt', 0)
                        - r.get('TotCPFAmt', 0) - r.get('TotImiAmt', 0)
                        - r.get('TotXchgAmt', 0)) < 1)
    assert closed > len(records) * 0.9, f'line totals do not close ({closed}/{len(records)})'


if __name__ == '__main__':
    recs, meta = build()
    check(recs)
    print(_reader.write('sale-lines', recs, meta))
    print(meta)
    for r in recs[:3]:
        print(r)
