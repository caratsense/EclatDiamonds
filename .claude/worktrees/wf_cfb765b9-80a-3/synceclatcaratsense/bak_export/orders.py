"""orders: Spm_MfgOrder -> POST /sync/orders payload, read out of the .bak.

Same selection as sync_sjep.extract_orders + stamp_branch: the header table is
Spm_MfgOrder (121 rows). SPM_MfgOrderItem is the LINE table and belongs to
/sync/order-items, not here. OrderProceedItem is a downstream proceed/issue log
keyed by OrderId — not a header either.

Spm_MfgOrder carries no branch column at all, so the branch comes from
BookNo -> BookMaster.BranchNo (a PartyNo), exactly as build_book_branch_map does,
and is sent as EclatBranchId. Books with no BranchNo (the HO series) get none —
the backend parks those in Unassigned rather than guessing a shop.

Read-only. Sale-side amounts only (Amount / GrossAmount); AllItemsCPFRate,
TotalAddlessAmount and the cost/labour chart ids are deliberately not emitted.
"""
import sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader

# Exactly what SyncService.syncOrders reads off a record, plus BookNo/OrderStatus
# for traceability (the handler ignores unknown keys).
KEEP = ('OrderId', 'OrderNo', 'OrderPrefix', 'OrderDate', 'CustomerId',
        'MadeFor_PartyNo', 'Amount', 'GrossAmount', 'PoNo', 'UpdateDate',
        'BookNo', 'OrderStatus')
NUM = ('Amount', 'GrossAmount')


def iso(v):
    return str(v).replace(' ', 'T') if v is not None else None


def build():
    book_branch = {}
    for b in _reader.rows('BookMaster'):
        no, br = b.get('BookNo'), b.get('BranchNo')
        if no is not None and br is not None and str(br).strip():
            book_branch[str(no).strip()] = str(br).strip()

    party_nos = {str(p.get('PartyNo')) for p in _reader.rows('PartyMst')}

    records, unknown_party = [], 0
    for o in _reader.rows('Spm_MfgOrder'):
        if o.get('OrderId') is None:      # legacy key the upsert dedupes on
            continue
        r = {k: o.get(k) for k in KEEP if o.get(k) is not None}
        for k in ('OrderDate', 'UpdateDate'):
            if k in r:
                r[k] = iso(r[k])
        for k in NUM:
            if k in r:
                r[k] = float(r[k])
        bn = book_branch.get(str(o.get('BookNo')).strip())
        if bn:
            r['EclatBranchId'] = bn
        cid = r.get('CustomerId')
        if cid and str(cid) not in party_nos:
            unknown_party += 1
        records.append(r)

    meta = {
        'source': 'APRSSJEP.bak (read-only)',
        'sourceTables': ['Spm_MfgOrder', 'BookMaster', 'PartyMst'],
        'handler': 'POST /sync/orders -> SyncService.syncOrders',
        'legacyIdField': 'OrderId',
        'branchFrom': 'BookNo -> BookMaster.BranchNo (PartyNo), sent as EclatBranchId',
        'withBranch': sum(1 for r in records if 'EclatBranchId' in r),
        'withoutBranch': sum(1 for r in records if 'EclatBranchId' not in r),
        'withCustomer': sum(1 for r in records if 'CustomerId' in r),
        'customerIdsNotInPartyMst': unknown_party,
        'omitted': {
            'EclatStage': 'no confirmed stage_map.json; OrderStatus is 0 or NULL on '
                          'every row here, so it decodes to nothing. Orders land as "booked".',
            'MadeFor_PartyNo': 'NULL on all 121 rows in this backup',
            'cost': 'AllItemsCPFRate / TotalAddlessAmount / rate+labour chart ids not emitted',
        },
    }
    return records, meta


def check():
    recs, meta = build()
    assert recs, 'no orders built'
    assert all(r.get('OrderId') is not None for r in recs), 'a record lost its legacy id'
    assert len({r['OrderId'] for r in recs}) == len(recs), 'duplicate OrderId'
    assert all(isinstance(r.get('Amount', 0.0), float) for r in recs), 'Amount not numeric'
    assert meta['withCustomer'] > 0 and meta['customerIdsNotInPartyMst'] == 0
    return recs, meta


if __name__ == '__main__':
    recs, meta = check()
    print(_reader.write('orders', recs, meta))
    print(len(recs), 'orders')
    for k, v in meta.items():
        if k != 'omitted':
            print(' ', k, '=', v)
    print('prefixes', collections.Counter(r.get('OrderPrefix') for r in recs))
    import json
    for r in (recs[0], recs[60], recs[-1]):
        print(json.dumps(r))
