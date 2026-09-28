"""Push the backup extracts into Eclat through POST /sync/<entity>.

Nothing here invents a credential: it reads an agent token that head office
issued, and identity headers that match the configuration head office approved
for that agent. Without both, it refuses rather than trying anything clever.

    set CARATOS_AGENT_TOKEN=...          (or write it to .agent_token)
    python push_backup.py --dry          what would go, and in what order
    python push_backup.py --only parties push one entity
    python push_backup.py                the whole thing, in dependency order

Order matters: a sale line needs its sale, stock needs its product, and
everything store-scoped needs the stores. Each batch's acknowledgement is
checked the way the on-site connector checks it - entity, counts, and that
upserted + skipped equals what was received - and the run stops on the first
batch that does not add up, rather than carrying on and reporting a total that
hides a hole.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# The extractors write their JSON beside themselves; SJEP_EXPORTS overrides.
EXPORTS = os.environ.get('SJEP_EXPORTS') or HERE
BASE = os.environ.get('ECLAT_BASE', 'https://backend-production-89dd.up.railway.app').rstrip('/')
BATCH = 500  # the DTO caps a batch at 5,000; smaller keeps a failure small

# Dependency order. sale-lines follows sales; stock follows products; anything
# store-scoped follows stores.
ORDER = [
    'stores', 'staff', 'parties', 'products', 'stock',
    'sales', 'sale-lines', 'orders', 'order-items',
    'bags', 'ledger', 'stock-movements',
]


def token():
    t = (os.environ.get('CARATOS_AGENT_TOKEN') or '').strip()
    if not t:
        path = os.path.join(HERE, '.agent_token')
        if os.path.isfile(path):
            t = open(path, encoding='utf-8').read().strip()
    if not t:
        sys.exit('No agent token. Head office issues one from the Data screen; '
                 'put it in CARATOS_AGENT_TOKEN or .agent_token.')
    return t


IDENTITY_KEYS = ('CARATOS_PROFILE_ID', 'CARATOS_PROFILE_HASH',
                 'CARATOS_SOURCE_INSTANCE_HASH', 'CARATOS_CONFIG_REVISION')


def headers():
    """The identity the approved configuration is pinned to.

    From the environment, or from `.agent_identity.json` beside this script.
    Not secrets - hashes of reviewed code and the id of the approved
    configuration - but the run fails closed without them, because sending a
    batch under the wrong generation is how a stale mapping quietly imports.
    """
    values = {k: (os.environ.get(k) or '').strip() for k in IDENTITY_KEYS}
    path = os.path.join(HERE, '.agent_identity.json')
    if os.path.isfile(path):
        stored = json.load(open(path, encoding='utf-8'))
        for k in IDENTITY_KEYS:
            values[k] = values[k] or str(stored.get(k, '')).strip()
    missing = [k for k in IDENTITY_KEYS if not values[k]]
    if missing:
        sys.exit('Missing identity headers: ' + ', '.join(missing) + '. These must match '
                 'the configuration head office approved for this agent.')
    return {
        'x-caratos-profile-id': values['CARATOS_PROFILE_ID'],
        'x-caratos-profile-hash': values['CARATOS_PROFILE_HASH'],
        'x-caratos-source-instance-hash': values['CARATOS_SOURCE_INSTANCE_HASH'],
        'x-caratos-config-revision': values['CARATOS_CONFIG_REVISION'],
    }


def load(entity):
    path = os.path.join(EXPORTS, f'{entity}.json')
    if not os.path.isfile(path):
        return None
    d = json.load(open(path, encoding='utf-8'))
    # `_branchName` and friends are readability aids in the extract; the handler
    # rejects unknown fields on the typed endpoints, so they are dropped here.
    rows = [{k: v for k, v in r.items() if not k.startswith('_')} for r in d['records']]
    allowed = TYPED_FIELDS.get(entity)
    if allowed:
        rows = [{k: v for k, v in r.items() if k in allowed} for r in rows]
    return rows


def post(entity, batch, tok, hdr, attempts=4):
    """Send one batch, retrying a dropped connection.

    Every endpoint upserts on the legacy id, so re-sending a batch that may have
    half-landed is safe and re-sending one that fully landed is a no-op. A
    timeout or a reset is therefore worth another go; an HTTP error is an answer
    and is returned as-is.
    """
    body = json.dumps({'records': batch}).encode()
    h = {'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'}
    h.update(hdr)
    last = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(f'{BASE}/sync/{entity}', data=body, headers=h, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                return r.status, json.loads(r.read().decode() or '{}')
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw)
            except Exception:  # noqa: BLE001
                return e.code, {'raw': raw[:400]}
        except Exception as e:  # noqa: BLE001 - timeouts, resets, DNS, TLS
            last = f'{type(e).__name__}: {e}'
            if attempt < attempts:
                wait = 5 * attempt
                print(f'    {entity}: {last} - retrying in {wait}s ({attempt}/{attempts - 1})')
                time.sleep(wait)
    return 0, {'raw': f'network failed after {attempts} attempts - {last}'}


# The typed endpoints declare their columns; anything else is an extract's own
# readability aid and would fail the whole batch on a strict DTO.
TYPED_FIELDS = {
    'stores': {'legacyId', 'name', 'city', 'code', 'state', 'pincode', 'country',
               'phone', 'email', 'gstin'},
    'staff': {'legacyId', 'name', 'email', 'phone', 'storeLegacyId', 'designation',
              'updatedAt'},
}


def check(entity, sent, status, ack):
    """The connector's own acknowledgement rules. A soft pass is not a pass.

    Three shapes, because the API has three. Reading the typed endpoints with
    the batch rules reports a mismatch on a push that landed, and a check that
    cries wolf gets ignored exactly when it matters.
    """
    if status not in (200, 201):
        return f'HTTP {status}: {json.dumps(ack)[:300]}'

    if entity == 'stores':
        # No per-row upsert count: a branch can be created, updated, or adopted
        # onto a store Eclat already had under a different name.
        touched = sum(len(ack.get(k) or []) for k in ('created', 'updated', 'adopted'))
        if touched > sent:
            return f'stores: {touched} touched is more than the {sent} sent'
        return None

    if entity == 'staff':
        received = ack.get('received')
        if received != sent:
            return f'received {received} does not match sent {sent}'
        parts = [ack.get(k) for k in ('created', 'updated', 'skipped')]
        if not all(isinstance(v, int) for v in parts):
            return 'staff acknowledgement did not carry integer counts'
        if sum(parts) != received:
            return f'created + updated + skipped ({sum(parts)}) does not equal received {received}'
        return None

    if ack.get('entity') != entity:
        return f"entity mismatch: asked {entity}, told {ack.get('entity')}"
    received = ack.get('received')
    if received != sent:
        return f'received {received} does not match sent {sent}'
    up, sk = ack.get('upserted'), ack.get('skipped')
    if not isinstance(up, int) or not isinstance(sk, int):
        return 'acknowledgement did not carry integer counts'
    if up + sk != received:
        return f'upserted {up} + skipped {sk} does not equal received {received}'
    return None


def summarise(entity, ack):
    if entity == 'stores':
        return (f"created={len(ack.get('created') or [])} updated={len(ack.get('updated') or [])} "
                f"adopted={len(ack.get('adopted') or [])} pending={ack.get('pendingCount')} "
                f"missingGeo={len(ack.get('missingGeo') or [])}")
    if entity == 'staff':
        return (f"created={ack.get('created')} updated={ack.get('updated')} "
                f"skipped={ack.get('skipped')} pendingStaff={ack.get('pendingStaff')}")
    return f"upserted={ack.get('upserted')} skipped={ack.get('skipped')}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--only', action='append', default=None)
    args = ap.parse_args()
    entities = args.only or ORDER

    plan = []
    for e in entities:
        rows = load(e)
        plan.append((e, rows))
    print(f'{"ENTITY":18} {"RECORDS":>8}')
    for e, rows in plan:
        print(f'{e:18} {"(no file)" if rows is None else f"{len(rows):,}":>8}')
    total = sum(len(r) for _, r in plan if r)
    print(f'{"TOTAL":18} {total:>8,}   -> {BASE}')
    if args.dry:
        return

    tok, hdr = token(), headers()
    grand = {'upserted': 0, 'skipped': 0}
    for e, rows in plan:
        if not rows:
            print(f'{e}: nothing to send')
            continue
        up = sk = 0
        for i in range(0, len(rows), BATCH):
            batch = rows[i:i + BATCH]
            status, ack = post(e, batch, tok, hdr)
            problem = check(e, len(batch), status, ack)
            if problem:
                print(f'{e}: STOPPED at batch {i // BATCH + 1} - {problem}')
                print(json.dumps(grand))
                sys.exit(1)
            up += ack.get('upserted') or ack.get('created') or 0
            sk += ack.get('skipped') or 0
            print(f'  {e} batch {i // BATCH + 1}: {summarise(e, ack)}')
        print(f'{e}: {up} in, {sk} skipped')
        grand['upserted'] += up
        grand['skipped'] += sk
    print(f'\nDONE upserted={grand["upserted"]:,} skipped={grand["skipped"]:,}')


if __name__ == '__main__':
    main()
