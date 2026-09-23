"""Journal (day book) -> POST /sync/ledger records, read out of the .bak.

Mirrors sync_sjep.extract_payments: Journal is the whole source, BookMaster is
the only join (BookNo -> BranchNo) and it exists solely to stamp EclatBranchId,
exactly as stamp_branch() does on the live DB. Journal itself carries no
location column.

Fields kept = the ones SyncService.syncLedger actually reads (Id, Amount,
TranType, Dr/CrAccountNo, Jdate, EntryDate, DocNo, TransNo, Remarks) plus BookNo
as the provenance of the branch stamp. Nothing here is a cost or purchase rate:
Journal holds posted amounts only.

Read-only; writes ledger.json next to this file.
"""
import sys
import os
from datetime import date, datetime
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader

# Fields copied straight through, blank/None dropped (str()/dt()/dec() on the
# backend all treat a missing key and '' identically, so an empty column is
# better left out than sent as '').
PASS = ('TranType', 'DrAccountNo', 'CrAccountNo', 'DocNo', 'TransNo', 'Remarks', 'BookNo')


def clean(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def build():
    journal = _reader.rows('Journal')
    # BookNo -> branch PartyNo. Same candidate order as build_book_branch_map();
    # on this backup BookMaster.BranchNo is the one that exists and resolves to
    # real shops (MUMBAI BANDRA, DELHI ROHINI, ...).
    books = _reader.rows('BookMaster')
    branch_of = {
        str(b['BookNo']).strip(): str(b['BranchNo']).strip()
        for b in books
        if b.get('BookNo') is not None and str(b.get('BranchNo') or '').strip()
    }

    records, stamped = [], 0
    for r in journal:
        if r.get('Id') is None or r.get('Amount') is None:
            continue  # legacyId + amount are what the handler refuses without
        rec = {'Id': r['Id'], 'Amount': clean(r['Amount'])}
        for k in PASS:
            v = clean(r.get(k))
            if v is not None:
                rec[k] = v
        for k in ('Jdate', 'EntryDate'):
            v = clean(r.get(k))
            if v is not None:
                rec[k] = v
        branch = branch_of.get(str(r.get('BookNo') or '').strip())
        if branch:
            rec['EclatBranchId'] = branch
            stamped += 1
        records.append(rec)

    meta = {
        'source_tables': ['Journal', 'BookMaster'],
        'legacy_id_field': 'Id',
        'branch_stamped': stamped,
        'branch_missing': len(records) - stamped,
        'note': 'BookMaster joined only to stamp EclatBranchId (BookNo -> BranchNo); '
                'rows on books with no BranchNo carry none and land unattributed.',
    }
    return records, meta


def demo():
    """One runnable check: the shape the handler needs, on real rows."""
    recs, meta = build()
    assert recs, 'no ledger records'
    assert all(r.get('Id') is not None for r in recs)
    assert len({r['Id'] for r in recs}) == len(recs), 'duplicate legacy Id'
    assert all(isinstance(r['Amount'], float) for r in recs)
    # TranType drives the income/expense split in syncLedger; unknown -> 'asset'.
    known = {'JWSL', 'BJWSL', 'MSL', 'JWPH', 'BJWPH', 'MPH', 'VCH'}
    assert {r.get('TranType') for r in recs} <= known, 'unmapped TranType'
    assert all(r.get('DrAccountNo') and r.get('CrAccountNo') for r in recs)
    assert all(str(r.get('Jdate', '')).startswith('20') for r in recs)
    return recs, meta


if __name__ == '__main__':
    recs, meta = demo()
    print(_reader.write('ledger', recs, meta))
    print(len(recs), 'records', meta)
    for r in recs[:1] + recs[len(recs) // 2:len(recs) // 2 + 1] + recs[-1:]:
        print(r)
