"""InwardHistory -> POST /sync/stock-movements payload, read off the .bak.

Mirrors extract_stock_movements() in sync_sjep.py (whole table, no join) and
emits exactly the five fields syncStockMovements() reads: Id (the legacy key it
upserts on), JewelId (resolved to a StockItem server-side), Jstatus, Trans,
TransactionDate. from/to store stay unset: LocationId is null throughout, the
same finding the connector recorded.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader

ISO = lambda v: v.isoformat() if hasattr(v, 'isoformat') else (None if v is None else str(v))


def build():
    hist = _reader.rows('InwardHistory')
    pieces = {r['JewelId'] for r in _reader.rows('Inward') if r.get('JewelId') is not None}
    status_names = {r['InwardStatusId']: r['InwardStatusName']
                    for r in _reader.rows('Const_InwardStatus')}

    records, no_id, no_piece = [], 0, 0
    for r in hist:
        if r.get('Id') is None or r.get('JewelId') is None:
            no_id += 1
            continue
        if r['JewelId'] not in pieces:
            no_piece += 1  # still emitted; the backend skips it until the piece exists
        rec = {'Id': r['Id'], 'JewelId': r['JewelId']}
        for src, val in (('Jstatus', r.get('Jstatus')), ('Trans', r.get('Trans'))):
            if val is not None and str(val).strip():
                rec[src] = str(val).strip()
        if r.get('TransactionDate') is not None:
            rec['TransactionDate'] = ISO(r['TransactionDate'])
        records.append(rec)

    meta = {
        'source': {'InwardHistory': len(hist)},
        'legacyIdField': 'Id',
        'droppedNoIdOrPiece': no_id,
        'jewelIdNotInInward': no_piece,   # backend skips these until the piece is synced
        'withDate': sum(1 for r in records if 'TransactionDate' in r),
        'withStatus': sum(1 for r in records if 'Jstatus' in r),
        'withTrans': sum(1 for r in records if 'Trans' in r),
        'locationIdNonNull': sum(1 for r in hist if r.get('LocationId') is not None),
        'statusCodes': sorted({r['Jstatus'] for r in records if 'Jstatus' in r}),
        'transValues': sorted({r['Trans'] for r in records if 'Trans' in r}),
        'constInwardStatus': {str(k): v for k, v in status_names.items()},
    }
    return records, meta


if __name__ == '__main__':
    recs, meta = build()
    assert recs and all(r.get('Id') is not None and r.get('JewelId') is not None for r in recs)
    assert len({r['Id'] for r in recs}) == len(recs), 'Id must be unique - it is the upsert key'
    print(_reader.write('stock-movements', recs, meta))
    print(len(recs), 'records')
    for k, v in meta.items():
        print(' ', k, '=', v)
    for r in recs[:3]:
        print(r)
