"""parties: PartyMst -> POST /sync/parties payload (raw legacy rows).

The endpoint takes raw legacy column names (SyncBatchDto.records) and maps them
server-side in SyncService.syncParties, upserting on PartyNo. So this emits the
source row, narrowed to the columns that handler + the branch resolver actually
read. Narrowed rather than SELECT * on purpose: PartyMst also carries LabourRate,
MetalLossPer, PM_BranchTranfer*Value, RateChartId and full bank details, none of
which the handler reads and none of which belongs in a sale-side export.

No child table is joined: the handler reads nothing outside PartyMst, and the
candidate children are empty on this backup (ContactList 2 rows,
PartyMstShippingInfo 1, PartyMstStaffAndFamilyDetail 2).

Read-only. Writes bakexport/parties.json and nothing else.
"""
import datetime
import decimal
import sys

sys.path.insert(0, r'C:/Users/Shrey/AppData/Local/Temp/claude/c--Users-Shrey-OneDrive-Desktop-Eclat/b57205d8-d1f2-4b9a-b580-57dc0e6f81d1/scratchpad/bakexport')
import _reader

# Exactly what sync.service.ts syncParties() reads, plus the branch columns from
# DEFAULT_BRANCH_COLUMNS.parties (EclatBranchId is synthetic — the live agent
# resolves it from BookMaster; there is no such column here, so it is omitted).
COLUMNS = [
    'PartyNo',                                              # legacy id, upsert key
    'IsCustomer', 'IsSupplier', 'IsSalesMan',
    'IsLocation', 'IsFactory', 'IsAccount',                 # -> types[]
    'FirmName', 'LegalName', 'PartyCode',
    'FirmTele', 'OwnerMobile', 'WhatsAppNo', 'FirmEmail',
    'FirmAdd1', 'FirmAdd2', 'FirmCity', 'FirmState', 'FirmCountry', 'FirmPinCode',
    'AccGst', 'FirmPan', 'AadhaarNo',
    'FirmBirthDate', 'FirmAnniversaryDate',
    'CreditLimit', 'IsBlackList', 'UpdateDate',
    'BranchNo', 'LocationId',                               # branch resolution
]


def clean(v):
    """JSON-safe: dates as ISO strings, decimals as numbers, blanks as null."""
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def build():
    src = _reader.rows('PartyMst')
    records, skipped = [], 0
    for r in src:
        if r.get('PartyNo') in (None, ''):
            skipped += 1                # no legacy id -> the handler would skip it too
            continue
        rec = {}
        for c in COLUMNS:
            v = clean(r.get(c))
            if v is not None:           # absent beats invented
                rec[c] = v
        records.append(rec)
    return src, records, skipped


def main():
    src, records, skipped = build()
    meta = {
        'source_tables': ['PartyMst'],
        'source_rows': len(src),
        'legacy_id_field': 'PartyNo',
        'endpoint': 'POST /sync/parties',
        'payload': 'raw legacy rows, narrowed to the columns syncParties() reads',
        'skipped_no_PartyNo': skipped,
        'excluded': 'LabourRate, MetalLossPer, PM_BranchTranfer*Value, RateChartId, '
                    'bank details, excise/tax registrations — unread by the handler',
    }
    out = _reader.write('parties', records, meta)

    # coverage, so a column that is 100% NULL is visible instead of quietly empty
    fill = {c: sum(1 for x in records if c in x) for c in COLUMNS}
    print(f'{len(records)} records -> {out}  (skipped {skipped})')
    for c in COLUMNS:
        print(f'  {fill[c]:4d}/{len(records)}  {c}')
    return records


def demo():
    """Self-check: every record carries the upsert key, and nothing leaks a rate."""
    _, records, _ = build()
    assert records, 'no records'
    assert all('PartyNo' in r for r in records)
    banned = {'LabourRate', 'MetalLossPer', 'RateChartId', 'BankAccNo',
              'PM_BranchTranferCostValue', 'PM_BranchTranferValue'}
    assert not any(banned & r.keys() for r in records)
    assert any(r.get('FirmName') for r in records), 'names all empty'
    print('ok')


if __name__ == '__main__':
    demo() if '--check' in sys.argv else main()
