"""order-items: SPM_MfgOrderItem -> POST /sync/order-items.

The handler (backend/src/sync/sync.service.ts syncOrderItems) reads raw legacy
column names and upserts on OrderItemId, so we ship legacy names verbatim and
only the columns it reads. No pricing is emitted: the handler reads none, and
SPM_MfgOrderItem's money columns are cost/markup, not sale rates.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _reader
from datetime import date, datetime
from decimal import Decimal


def jsonable(v):
    """Dates as ISO strings, decimals as numbers - what sync.util dt()/int() expect."""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v

# Exactly what syncOrderItems() reads. Anything else is dead weight in the payload.
OPTIONAL = ('SKUNo', 'SpecialRemarks', 'OrderQty', 'Completed', 'ExpDelDate', 'Inward_JewelId')


def build():
    order_ids = {r['OrderId'] for r in _reader.rows('Spm_MfgOrder') if r.get('OrderId') is not None}
    items = _reader.rows('SPM_MfgOrderItem')
    # SPM_MfgOrderItem.SKUNo is blank on this install; the same per-line SKU sits
    # 1:1 in the summary table (1220/1220 filled), so take it from there.
    sku = {r['OrderItemId']: r.get('OrderItemSKUNo')
           for r in _reader.rows('SPM_MfgOrderItemSummary')}
    from_summary = 0

    records, orphans, no_key = [], 0, 0
    for r in items:
        oid, iid = r.get('OrderId'), r.get('OrderItemId')
        if oid is None or iid is None:
            no_key += 1
            continue
        if oid not in order_ids:          # header not in this backup -> handler would skip it anyway
            orphans += 1
            continue
        rec = {'OrderItemId': iid, 'OrderId': oid}
        for c in OPTIONAL:
            v = r.get(c)
            if v is not None and v != '':
                rec[c] = jsonable(v)
        if 'SKUNo' not in rec and sku.get(iid):
            rec['SKUNo'] = sku[iid]
            from_summary += 1
        records.append(rec)

    filled = {c: sum(1 for x in records if c in x) for c in OPTIONAL}
    meta = {
        'source_tables': ['SPM_MfgOrderItem', 'Spm_MfgOrder', 'SPM_MfgOrderItemSummary'],
        'sku_from_summary': from_summary,
        'legacy_id_field': 'OrderItemId',
        'order_link_field': 'OrderId',
        'rows_in_source': len(items),
        'skipped_orphan_orderid': orphans,
        'skipped_missing_key': no_key,
        'field_fill_counts': filled,
    }
    return records, meta


def demo():
    recs, meta = build()
    assert recs, 'no order items built'
    assert len({r['OrderItemId'] for r in recs}) == len(recs), 'OrderItemId not unique'
    assert all(r['OrderId'] is not None for r in recs)
    assert meta['field_fill_counts']['OrderQty'] > 0, 'OrderQty empty everywhere - wrong column'
    assert meta['field_fill_counts']['SKUNo'] > 0, 'SKUNo empty everywhere - wrong column'
    return recs, meta


if __name__ == '__main__':
    records, meta = demo()
    path = _reader.write('order-items', records, meta)
    print(len(records), 'records ->', path)
    print(meta)
    for r in records[:3]:
        print(r)
