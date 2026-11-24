"""SPM_BagMaster -> POST /sync/bags payload, read out of the .bak.

Mirrors extract_bags() in synceclatcaratsense/sync_sjep.py: SPM_BagMaster rows,
joined to SPM_DepartmentMst so Eclat stores a department NAME. Only the fields
syncBags() in backend/src/sync/sync.service.ts actually reads are emitted.

NOT emitted, and why:
  EclatStage      - stage_map.json is still the unfilled template, and this
                    install has exactly ONE department ("Self"), so there is no
                    department->stage decode to make. Without it the bag still
                    imports; it just doesn't advance its order. Guessing would
                    silently mislabel every order's timeline.
  UpdateDate      - SPM_BagMaster has no such column on this schema, so
                    legacyUpdatedAt stays null rather than being faked from
                    EntryDate (which is creation, not last change).

Read-only: the backup is never written.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader

SALE_SAFE = ('BagId', 'OrderId', 'BagNo', 'BagBarcode', 'DepartmentId',
             'DepartmentName', 'BagStatus', 'GrossWt', 'NetWt',
             'IsBagComplete', 'BagDate')  # no rate/cost column among them


def _num(v):
    return None if v is None else float(v)


def _iso(v):
    return None if v is None else (v.isoformat() if hasattr(v, 'isoformat') else str(v))


def build():
    bags = _reader.rows('SPM_BagMaster')
    dept = {str(d['DepartmentId']): (d.get('DepartmentName') or '').strip()
            for d in _reader.rows('SPM_DepartmentMst')}

    records = []
    for b in bags:
        if b.get('BagId') is None:
            continue  # no legacy key => not re-runnable, drop it
        records.append({
            'BagId': b['BagId'],
            'OrderId': b.get('OrderId'),
            'BagNo': b.get('BagNo'),
            'BagBarcode': b.get('BagBarcode'),
            'DepartmentId': b.get('DepartmentId'),
            'DepartmentName': dept.get(str(b.get('DepartmentId'))) or None,
            'BagStatus': b.get('BagStatus'),
            'GrossWt': _num(b.get('GrossWt')),
            'NetWt': _num(b.get('NetWt')),
            'IsBagComplete': b.get('IsBagComplete'),
            'BagDate': _iso(b.get('BagDate')),
        })
    return bags, records


def main():
    bags, records = build()
    named = sum(1 for r in records if r['DepartmentName'])
    orders = {r['OrderId'] for r in records if r['OrderId'] is not None}
    meta = {
        'source': 'APRSSJEP.bak',
        'sourceTables': ['SPM_BagMaster', 'SPM_DepartmentMst'],
        'legacyIdField': 'BagId',
        'sourceRows': len(bags),
        'distinctOrders': len(orders),
        'departmentNamed': named,
        'omitted': {
            'EclatStage': 'stage_map.json unconfirmed and only one department on '
                          'this install - no department->stage decode exists',
            'UpdateDate': 'column absent from SPM_BagMaster',
        },
    }
    path = _reader.write('bags', records, meta)

    # self-check: every record re-runnable, keys unique, weights real, no cost data
    assert records, 'no bag records'
    assert all(r['BagId'] is not None for r in records)
    assert len({r['BagId'] for r in records}) == len(records), 'BagId not unique'
    assert all(set(r) <= set(SALE_SAFE) for r in records), 'unexpected field emitted'
    assert sum(1 for r in records if r['GrossWt']) > len(records) // 2, 'weights look empty'
    print(f'{len(records)} bags -> {path}')
    print(f'  {len(orders)} distinct OrderId, {named} with a department name')
    for r in (records[0], records[len(records) // 2], records[-1]):
        print('  ', r)


if __name__ == '__main__':
    main()
