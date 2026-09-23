"""stores: the shops, out of PartyMst -> POST /sync/stores payload.

Unlike /sync/parties this endpoint takes a MAPPED row (StoreSyncRowDto:
legacyId, name, city, code, addressLine1/2, state, pincode, country, phone,
email, gstin) and upserts on `legacyId`. So this maps here, the way
sync_sjep.py push_stores() does against the live DB.

WHICH PARTIES ARE BRANCHES: not the IsLocation/IsFactory flag rows — push_stores
explains why that flag returned suppliers and holding companies on this client's
install. A branch is a party the data is RECORDED AGAINST: any id appearing as a
BranchNo/LocationId. Confirmed here: the flags and the referenced ids do not
overlap at all, and the 8 referenced ids are the 8 shops (A001..A008).

Read-only. Writes bakexport/stores.json and nothing else.
"""
import sys

sys.path.insert(0, r'C:/Users/Shrey/AppData/Local/Temp/claude/c--Users-Shrey-OneDrive-Desktop-Eclat/b57205d8-d1f2-4b9a-b580-57dc0e6f81d1/scratchpad/bakexport')
import _reader

# Same probes as push_stores(). JewelTrans.BranchNo and a few others simply do
# not exist on this schema version; a missing column contributes nothing rather
# than erroring, same as the live agent's table_columns() guard.
BRANCH_REFS = [
    ('Inward', 'BranchNo'),
    ('PartyMst', 'BranchNo'),
    ('BookMaster', 'BranchNo'),
    ('Inward', 'LocationId'),
    ('JewelTrans', 'BranchNo'),
]

# PartyMst column -> DTO field. Sale-side identity and address only; no rate
# chart, no labour rate, no credit limit, no bank details.
FIELDS = [
    ('FirmCity', 'city'),
    ('PartyCode', 'code'),
    ('FirmAdd1', 'addressLine1'),
    ('FirmAdd2', 'addressLine2'),
    ('FirmState', 'state'),
    ('FirmPinCode', 'pincode'),   # push_stores looks for "pincode"; the column
                                  # is FirmPinCode here, so the live agent drops
                                  # it. Mapped, see the report.
    ('FirmCountry', 'country'),
    ('FirmTele', 'phone'),
    ('FirmEmail', 'email'),
    ('AccGst', 'gstin'),
]


def txt(v):
    """Trimmed string, or '' for NULL/blank — the DTO's strings are all optional
    and a blank must be left out, not sent as an empty string."""
    return '' if v is None else str(v).strip()


def referenced_branch_ids():
    ids = {}
    for table, col in BRANCH_REFS:
        hits = 0
        for r in _reader.rows(table):
            if col not in r:
                break                       # column absent on this schema
            v = txt(r.get(col))
            if v:
                ids[v] = ids.get(v, 0) + 1
                hits += 1
        print(f'  {table}.{col}: {hits} row(s) name a branch')
    return ids


def main():
    refs = referenced_branch_ids()
    print(f'  {len(refs)} distinct party id(s) are referenced as a branch')

    records, seen = [], []
    for p in _reader.rows('PartyMst'):
        legacy = txt(p.get('PartyNo'))
        if legacy not in refs:
            continue
        name = txt(p.get('FirmName')) or txt(p.get('LegalName'))
        if not name:
            seen.append((legacy, 'no FirmName/LegalName — skipped'))
            continue
        rec = {'legacyId': legacy, 'name': name}
        for src, dest in FIELDS:
            v = txt(p.get(src))
            if v:
                rec[dest] = v
        # FirmAdd3 folds into line 2: Eclat holds two lines and dropping the
        # third silently loses part of a real address.
        add3 = txt(p.get('FirmAdd3'))
        if add3:
            head = rec.get('addressLine2', '').rstrip(' ,')
            rec['addressLine2'] = f'{head}, {add3}' if head else add3
        # Multi-line address text out of the legacy UI would break a single-line
        # field on a document print.
        for k in ('addressLine1', 'addressLine2'):
            if k in rec:
                rec[k] = ' '.join(rec[k].split())
        records.append(rec)
        seen.append((legacy, f'{name} ({refs[legacy]} row(s) reference it)'))

    for legacy, why in sorted(seen):
        print(f'  {legacy}  {why}')

    missing = sorted(set(refs) - {r['legacyId'] for r in records})
    if missing:
        print(f'  referenced but not a PartyMst row: {missing}')

    fields = sorted({k for r in records for k in r})
    meta = {
        'source': 'PartyMst, branch ids referenced by Inward/PartyMst/BookMaster',
        'endpoint': 'POST /sync/stores (SyncStoresDto)',
        'upsertKey': 'legacyId (PartyMst.PartyNo)',
        'branchDetection': 'referenced as BranchNo, NOT IsLocation/IsFactory',
        'fields': fields,
        'unreferencedIds': missing,
    }
    out = _reader.write('stores', records, meta)
    print(f'{len(records)} store(s) -> {out}')
    print('fields present:', fields)

    assert records, 'no stores extracted'
    assert all(r['legacyId'] and r['name'] for r in records), 'legacyId/name must be filled'
    assert len({r['legacyId'] for r in records}) == len(records), 'legacyId must be unique'


if __name__ == '__main__':
    main()
