"""staff -> POST /sync/staff (StaffSyncRowDto), extracted from APRSSJEP.bak. Read-only.

Source is SPM_Users, NOT PartyMst.IsSalesMan: this backup has exactly ONE
IsSalesMan party and it is a test row called "XYZ" with no email, phone or
branch. sync_sjep.push_staff's predicate finds nothing real here, so the
fallback the DTO documents is used instead — "legacyId is ... the SPM_Users id".

Branch: SPM_Users.BranchNo already carries PartyNo values, and the seven ids it
uses are exactly the seven referenced as Inward.BranchNo — i.e. the same set
push_stores sends as stores. So storeLegacyId resolves.

Not emitted, because the source has no value: email (UserEmailAddress is NULL on
all 15 rows), phone (no column), designation (RoleId is 1 for everyone with no
role master; the only department is "Self").
"""
import sys
sys.path.insert(0, r'C:/Users/Shrey/AppData/Local/Temp/claude/c--Users-Shrey-OneDrive-Desktop-Eclat/b57205d8-d1f2-4b9a-b580-57dc0e6f81d1/scratchpad/bakexport')
import _reader


def iso(v):
    return v.isoformat() if v is not None else None


def first_branch(v):
    """BranchNo is usually one PartyNo but row 15 holds ', 0001000026'."""
    return next((p.strip() for p in str(v or '').split(',') if p.strip()), None)


def build(users):
    records, dropped = [], []
    for u in sorted(users, key=lambda r: r['UserId']):
        uid, name = u['UserId'], (u.get('UserName') or '').strip()
        if uid < 0:
            dropped.append((uid, 'system sentinel account'));  continue
        if u.get('IsDelete'):
            dropped.append((uid, 'IsDelete = 1'));  continue
        if not name:
            dropped.append((uid, 'no UserName'));  continue
        rec = {'legacyId': str(uid), 'name': name}
        store = first_branch(u.get('BranchNo'))
        if store:
            rec['storeLegacyId'] = store
        # UpdateDate is NULL on most rows; EntryDate is the only other record of
        # when the row last changed. Both are real columns, nothing invented.
        upd = iso(u.get('UpdateDate') or u.get('EntryDate'))
        if upd:
            rec['updatedAt'] = upd
        assert 'password' not in ' '.join(rec).lower()
        records.append(rec)
    return records, dropped


def main():
    users = _reader.rows('SPM_Users')
    records, dropped = build(users)
    stores = sorted({r['storeLegacyId'] for r in records if 'storeLegacyId' in r})
    meta = {
        'source_tables': ['SPM_Users'],
        'source_rows': len(users),
        'dropped': [{'legacyId': str(i), 'reason': w} for i, w in dropped],
        'legacy_id_field': 'SPM_Users.UserId',
        'store_legacy_ids': stores,
        'fields_omitted_no_source': ['email', 'phone', 'designation'],
        'note': 'PartyMst.IsSalesMan holds 1 test row ("XYZ") — unusable, not used.',
    }
    print(_reader.write('staff', records, meta), len(records), 'records')
    for r in records[:3]:
        print(r)
    print('dropped:', dropped)


def demo():
    fake = [
        {'UserId': -99, 'UserName': 'Maintenance', 'IsDelete': False, 'BranchNo': None},
        {'UserId': 3, 'UserName': 'BO2~3   ', 'IsDelete': True, 'BranchNo': ''},
        {'UserId': 15, 'UserName': ' MUKG01 ', 'IsDelete': False, 'BranchNo': ', 0001000026',
         'UpdateDate': None, 'EntryDate': __import__('datetime').datetime(2026, 6, 3, 13, 54)},
    ]
    recs, dropped = build(fake)
    assert [d[0] for d in dropped] == [-99, 3], dropped
    assert recs == [{'legacyId': '15', 'name': 'MUKG01', 'storeLegacyId': '0001000026',
                     'updatedAt': '2026-06-03T13:54:00'}], recs
    print('demo ok')


if __name__ == '__main__':
    demo()
    main()
