"""Sale headers out of the APRSSJEP backup, in the shape POST /sync/sales takes.

Source of truth for the mapping: sync_sjep.py extract_sales() (JewelTrans, the
invoice header) + build_book_branch_map()/stamp_branch() (BookMaster.BranchNo is
the only thing tying a transaction to a shop -- JewelTrans.LocationId is 100%
NULL here, same as on the live DB).

Destination: SyncService.syncSales() reads exactly JewelTransId, PartyNo,
TranType, JewelTransPrefix, JewelTransNo, JewelTransDate, GrossAmount, Amount,
Remarks, isCancel, UpdateDate and the branch columns. Only those are emitted --
JewelTrans has 57 columns and the rest are noise the handler ignores.

Read-only. Writes bakexport/sales.json and nothing else.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader


def iso(v):
    return v.isoformat() if v is not None else None


def clean(s):
    s = (s or '').strip()
    return s or None


def build():
    # BookNo -> branch PartyNo. Same one hop the connector makes; the branch
    # column on this install is BookMaster.BranchNo.
    book_branch = {
        str(b['BookNo']): str(b['BranchNo']).strip()
        for b in _reader.rows('BookMaster')
        if b.get('BranchNo') and str(b['BranchNo']).strip()
    }
    branch_name = {
        str(p.get('PartyNo')).strip(): clean(p.get('FirmName'))
        for p in _reader.rows('PartyMst')
    }

    # A purchase invoice's Amount is what the shop paid its vendor, which is cost
    # and is not ours to carry. docTypeFromTranType (backend/src/sync/sync.util.ts)
    # maps JWPH and BJWPH to 'purchase'; dropping them costs nothing downstream,
    # because branch transfers are JWBAP/JWBAI and are kept.
    PURCHASE = {'JWPH', 'BJWPH'}

    records, unattributed, purchases_dropped = [], 0, 0
    for r in _reader.rows('JewelTrans'):
        if r.get('JewelTransId') is None:
            continue  # handler would skip it anyway
        if str(r.get('TranType') or '').strip().upper() in PURCHASE:
            purchases_dropped += 1
            continue
        rec = {
            'JewelTransId': r['JewelTransId'],          # legacy key: Sale.legacyId
            'PartyNo': clean(r.get('PartyNo')),
            'TranType': clean(r.get('TranType')),        # -> docType
            'JewelTransPrefix': clean(r.get('JewelTransPrefix')),
            'JewelTransNo': clean(r.get('JewelTransNo')),
            'JewelTransDate': iso(r.get('JewelTransDate')),
            'GrossAmount': float(r['GrossAmount']) if r.get('GrossAmount') is not None else None,
            'Amount': float(r['Amount']) if r.get('Amount') is not None else None,
            'BookNo': r.get('BookNo'),                   # provenance of EclatBranchId
        }
        # Only when the source actually has one. isCancel and SalesPersonNo are
        # NULL on all 239 rows, so they are left out rather than sent as false/null.
        if clean(r.get('Remarks')):
            rec['Remarks'] = clean(r.get('Remarks'))
        if r.get('UpdateDate') is not None:
            rec['UpdateDate'] = iso(r['UpdateDate'])

        branch = book_branch.get(str(r.get('BookNo')))
        if branch:
            rec['EclatBranchId'] = branch
            rec['_branchName'] = branch_name.get(branch)  # human check only
        else:
            unattributed += 1
        records.append(rec)

    meta = {
        'purchasesDropped': purchases_dropped,
        'source': 'APRSSJEP.bak (read-only)',
        'tables': ['JewelTrans', 'BookMaster', 'PartyMst'],
        'legacyIdField': 'JewelTransId',
        'branchVia': 'BookMaster.BranchNo (JewelTrans.LocationId is NULL on every row)',
        'unattributed': unattributed,
        'omitted': 'isCancel + SalesPersonNo: NULL on all rows. Cost/purchase '
                   'pricing columns not emitted. _branchName is a readability '
                   'aid, not consumed by the handler.',
    }
    return records, meta


def check(records):
    assert records, 'no records'
    assert all(r['JewelTransId'] is not None for r in records), 'record without legacy id'
    ids = [r['JewelTransId'] for r in records]
    assert len(ids) == len(set(ids)), 'duplicate JewelTransId would collide on upsert'
    assert all(r['JewelTransDate'] and r['Amount'] is not None for r in records), 'undated or unpriced sale'
    banned = {'PurchaseRate', 'CostPrice', 'AllItemsCPFRate', 'TotalBrokerageAmount'}
    assert not banned & set().union(*(set(r) for r in records)), 'cost/supplier pricing leaked'


if __name__ == '__main__':
    records, meta = build()
    check(records)
    print(_reader.write('sales', records, meta))
    print(f"{len(records)} records, {meta['unattributed']} without a branch")
    for r in records[:2] + records[-1:]:
        print(r)
