"""
Eclat / CaratSense Auto Sync — reads directly from the live SJE Plus / APRS-SJEP
SQL Server database and pushes new sales / orders / stock / parties to the Eclat
backend. No manual export. Runs every 15 min + at Windows login (Task Scheduler).

Modeled on the proven Busy->CaratSense sync (auto_sync_busy.py, Ashish Textile),
repointed from MS Access to SQL Server.

STATUS: extract_*() SQL bodies are now REAL queries against the restored
APRS-SJEP schema (verified against docs/legacy-schema.md and the restored
copy `APRSSJEP_eclat` on localhost\\SQLEXPRESS). Scheduling, watermark,
reliability are final.

-------------------------------------------------------------------------------
PRODUCTION TARGET (READ THIS):
  The original skeleton POSTed Excel files to a `/upload/excel` endpoint. That
  endpoint DOES NOT EXIST in the Eclat NestJS backend. The live-sync target for
  production is ONE of:
    (a) the Eclat REST API (NestJS) — a per-entity bulk-upsert route keyed on
        legacyId (e.g. POST /sync/parties, /sync/stock, /sync/sales, ...),  OR
    (b) a direct Postgres load (the same upsert-on-legacyId logic used by the
        one-time backfill at backend/scripts/backfill-legacy.mjs).

  Until that ingestion route is finalised, the extract_*() functions below are
  the contract: they return clean lists of dict records (column name -> value),
  already filtered by the incremental watermark. upload_chunked() / the
  /upload/excel path is left in place only as a reference shape and is NOT the
  production sink — wire the records into (a) or (b) before scheduling.

RESTORED-COPY vs LIVE-DB NOTES:
  * These SELECTs were validated against the RESTORED backup copy
    (`APRSSJEP_eclat`, a fresh-looking install: ~564 parties, 2,690 inward
    pieces, 239 JewelTrans, 121 mfg orders, 475 journal rows).
  * On the CLIENT'S LIVE server the database name is `APRSSJEP` (see SQL_DB
    default) and will contain more / continuously-changing rows. The queries are
    identical; only the connection target differs. Anything that still needs the
    on-site live DB is marked `# LIVE-DB:` inline.
"""
import os
import sys
import json
import hashlib
import logging
import requests
from datetime import datetime, date
from decimal import Decimal

# ── Configuration (from environment or eclat_config.bat) ──
# Multiple targets supported: comma-separate ECLAT_BASE_URL to push the SAME real
# data to several backends in one run — e.g. local dev + production together:
#   set ECLAT_BASE_URL=http://localhost:4000,https://backend-production-89dd.up.railway.app
BACKENDS    = [u.strip().rstrip("/") for u in os.getenv("ECLAT_BASE_URL", "").split(",") if u.strip()]
EMAIL       = os.getenv("ECLAT_EMAIL", "")
PASSWORD    = os.getenv("ECLAT_PASSWORD", "")
# SQL Server connection — live, READ-ONLY. Use a least-privilege read-only login.
SQL_SERVER  = os.getenv("SJEP_SQL_SERVER", r"localhost\SQLEXPRESS")
SQL_DB      = os.getenv("SJEP_SQL_DB", "APRSSJEP")
SQL_USER    = os.getenv("SJEP_SQL_USER", "")          # blank => Windows auth
SQL_PASS    = os.getenv("SJEP_SQL_PASS", "")

if not BACKENDS or not EMAIL or not PASSWORD:
    print("ERROR: Eclat env vars not set. Run via eclat_config.bat")
    sys.exit(1)

# Per-target watermark (JSON: { base_url: last_synced_iso }) so each backend
# (local + production) advances independently — one offline never blocks the others.
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_state.json")
LOG_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auto_sync.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("eclat-sync")


# ── Watermark: per-target last-synced marker so we only push NEW data ──
def load_state():
    """Read { base_url: last_synced_iso }. Empty = everything is a full backfill."""
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        log.error(f"Could not save state: {e}")


# ── Connections ──
def login(base_url):
    try:
        r = requests.post(f"{base_url}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
        if 200 <= r.status_code < 300:  # NestJS returns 201 on POST /auth/login
            log.info(f"Login OK: {base_url}")
            return r.json().get("token")
        log.error(f"Login failed ({base_url}): {r.status_code}")
    except Exception as e:
        log.error(f"Login error ({base_url}): {e}")
    return None


def connect_sql():
    """Connect READ-ONLY to the live SJE Plus SQL Server. Never writes."""
    try:
        import pyodbc
        if SQL_USER:
            cs = (f"Driver={{ODBC Driver 17 for SQL Server}};Server={SQL_SERVER};"
                  f"Database={SQL_DB};UID={SQL_USER};PWD={SQL_PASS};ApplicationIntent=ReadOnly;")
        else:
            cs = (f"Driver={{ODBC Driver 17 for SQL Server}};Server={SQL_SERVER};"
                  f"Database={SQL_DB};Trusted_Connection=yes;ApplicationIntent=ReadOnly;")
        return pyodbc.connect(cs, timeout=30, readonly=True)
    except Exception as e:
        log.error(f"Cannot connect to SQL Server {SQL_SERVER}/{SQL_DB}: {e}")
        return None


def table_columns(cursor, table):
    """Lowercased->actual column map; APRS schema varies by version, so adapt."""
    try:
        cursor.execute(f"SELECT TOP 0 * FROM {table}")
        return {str(d[0]).lower(): str(d[0]) for d in cursor.description}
    except Exception:
        return {}


# ── Extractors — REAL SQL against the APRS-SJEP schema ──
# Every transaction table has an identity-bigint PK (monotonic, best for NEW rows)
# plus EntryDate/UpdateDate (for CHANGED rows). The incremental filter is:
#     UpdateDate > @since  OR  (UpdateDate IS NULL AND EntryDate > @since)
# `since` is the last-synced UpdateDate/EntryDate watermark (ISO string), '' = full
# backfill. Master tables (PartyMst, StyleMst) and current stock (Inward) are pulled
# in full each cycle when `since` is given as a date too, since they are small.
#
# Each extractor returns a list[dict] (column name -> value); rows() helper maps the
# pyodbc cursor description to dicts. Callers feed these into the production sink
# (Eclat REST API or direct Postgres load — see module header).

def rows(cursor):
    """Materialise the current cursor result set as a list of dicts."""
    cols = [d[0] for d in cursor.description]
    return [dict(zip(cols, r)) for r in cursor.fetchall()]


def _wm(cursor, table):
    """Incremental-watermark WHERE clause using whichever of UpdateDate/EntryDate
    actually exist on `table`. Returns (clause, n_params). Schema-adaptive: a table
    with neither date column just does a full pull each time."""
    c = table_columns(cursor, table)
    upd = "updatedate" in c
    ent = "entrydate" in c
    if upd and ent:
        return ("(? = '' OR (t.UpdateDate IS NULL AND t.EntryDate > CONVERT(datetime, ?)) "
                "OR (t.UpdateDate IS NOT NULL AND t.UpdateDate > CONVERT(datetime, ?)))", 3)
    if ent:
        return ("(? = '' OR t.EntryDate > CONVERT(datetime, ?))", 2)
    if upd:
        return ("(? = '' OR t.UpdateDate > CONVERT(datetime, ?))", 2)
    return ("1=1", 0)


def _base(cursor, table, since):
    """SELECT * from a base table with the adaptive watermark. SELECT * never
    fails on a missing column and pulls EVERY available field."""
    if not table_columns(cursor, table):
        return []
    wm, n = _wm(cursor, table)
    cursor.execute(f"SELECT * FROM {table} t WHERE {wm}", *([since] * n))
    return rows(cursor)


def _merge_1to1(cursor, base_rows, table, key):
    """Merge a 1:1 summary table (e.g. InwardSummary) into base_rows on `key`.
    Adds summary columns not already present (base wins on a name clash)."""
    cols = table_columns(cursor, table)
    if not base_rows or not cols or key.lower() not in cols:
        return
    cursor.execute(f"SELECT * FROM {table}")
    by = {}
    for r in rows(cursor):
        k = r.get(key)
        if k is not None:
            by[k] = r
    for b in base_rows:
        s = by.get(b.get(key))
        if s:
            for col, val in s.items():
                if col not in b:
                    b[col] = val


def _merge_lookup(cursor, base_rows, table, base_key, lookup_key, want):
    """Merge selected columns from a lookup table (e.g. ToneMst) into base_rows,
    matching base_rows[base_key] == lookup[lookup_key]."""
    cols = table_columns(cursor, table)
    if not base_rows or not cols or lookup_key.lower() not in cols:
        return
    cursor.execute(f"SELECT * FROM {table}")
    by = {}
    for r in rows(cursor):
        k = r.get(lookup_key)
        if k is not None:
            by[k] = r
    for b in base_rows:
        l = by.get(b.get(base_key))
        if l:
            for w in want:
                if w in l and w not in b:
                    b[w] = l[w]


def extract_parties(cursor, since=""):
    """Customers / suppliers / salespersons / branches — PartyMst master (SELECT *,
    every field). Branch/location rows become Eclat Stores; role flags -> Party.types."""
    return _base(cursor, "PartyMst", since)


def extract_items(cursor, since=""):
    """Designs = StyleMst (+ StyleMstSummary 1:1 weights/amounts, + ToneMst metal)."""
    items = _base(cursor, "StyleMst", since)
    _merge_1to1(cursor, items, "StyleMstSummary", "StyleId")
    _merge_lookup(cursor, items, "ToneMst", "MetalToneNo", "ToneNo", ["ToneCode", "ToneFor"])
    return items


def extract_stock(cursor, since=""):
    """Per-piece stock = Inward (+ InwardSummary 1:1 weights/amounts, + ToneMst metal).
    SELECT * so a missing column (e.g. MRP on some versions) never crashes the pull."""
    stock = _base(cursor, "Inward", since)
    _merge_1to1(cursor, stock, "InwardSummary", "JewelId")
    _merge_lookup(cursor, stock, "ToneMst", "MetalToneNo", "ToneNo", ["ToneCode", "ToneFor"])
    return stock


def extract_sales(cursor, since=""):
    """Invoice headers = JewelTrans (SELECT *). Lines via extract_sale_lines().
    TranType selects the doc kind (sale/purchase/branch transfer/proforma/return)."""
    return _base(cursor, "JewelTrans", since)


def extract_sale_lines(cursor, trans_ids):
    """Per-line component-priced snapshot for a set of JewelTransIds.
    JewelTransInward = the line (a JewelId on a bill); JewelTransInwardSummary = its
    weight/amount rollup. (JewelTransInward has no own identity — keyed by parent.)
    Pass the JewelTransIds returned by extract_sales()."""
    if not trans_ids or not table_columns(cursor, "JewelTransInward"):
        return []
    ph = ",".join("?" for _ in trans_ids)
    cursor.execute(f"SELECT * FROM JewelTransInward WHERE JewelTransId IN ({ph})", *trans_ids)
    lines = rows(cursor)
    sc = table_columns(cursor, "JewelTransInwardSummary")
    if lines and sc and "jeweltransid" in sc and "jewelid" in sc:
        cursor.execute(
            f"SELECT * FROM JewelTransInwardSummary WHERE JewelTransId IN ({ph})", *trans_ids)
        by = {}
        for r in rows(cursor):
            by[(r.get("JewelTransId"), r.get("JewelId"))] = r
        for b in lines:
            s = by.get((b.get("JewelTransId"), b.get("JewelId")))
            if s:
                for col, val in s.items():
                    if col not in b:
                        b[col] = val
    return lines


def extract_orders(cursor, since=""):
    """Manufacturing/custom-production orders = Spm_MfgOrder (→ Eclat
    ManufacturingOrder). Lines = SPM_MfgOrderItem (extract_order_items). OrderStatus is
    an int production stage (decode against legacy status master before trusting in
    Module 8 timelines — # LIVE-DB: confirm OrderStatus codes on the client install).
    ~121 orders."""
    return _base(cursor, "Spm_MfgOrder", since)


def extract_order_items(cursor, order_ids):
    """Line items for a set of OrderIds: SPM_MfgOrderItem (→ ManufacturingOrderItem).
    Inward_JewelId = the produced piece once made."""
    if not order_ids or not table_columns(cursor, "SPM_MfgOrderItem"):
        return []
    ph = ",".join("?" for _ in order_ids)
    cursor.execute(f"SELECT * FROM SPM_MfgOrderItem WHERE OrderId IN ({ph})", *order_ids)
    return rows(cursor)


# ── Manufacturing timeline ────────────────────────────────────────────────────
# The order header's `OrderStatus` is one int and says nothing about where a piece
# has actually got to. What moves through the factory is a BAG, and SPM_BagMaster
# carries its department + status — so the bag rows ARE the timeline.
#
# Both the OrderStatus ints and the DepartmentIds are per-install, so the decode
# lives in stage_map.json (written by discover.py, confirmed by a human) rather
# than being hardcoded here. Anything unmapped is still recorded; it just doesn't
# move the order, which is the safe direction to be wrong in.
_STAGE_MAP_CACHE = None


def stage_map():
    """Load stage_map.json once. Absent => everything stays 'booked'."""
    global _STAGE_MAP_CACHE
    if _STAGE_MAP_CACHE is not None:
        return _STAGE_MAP_CACHE
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stage_map.json")
    try:
        with open(path, encoding="utf-8") as f:
            _STAGE_MAP_CACHE = json.load(f)
        log.info(f"  stage_map.json loaded "
                 f"({len(_STAGE_MAP_CACHE.get('departmentToStage', {}))} departments, "
                 f"{len(_STAGE_MAP_CACHE.get('orderStatusToStage', {}))} order codes)")
    except FileNotFoundError:
        log.warning("  stage_map.json not found — orders stay at 'booked'. "
                    "Run discover.bat, confirm stage_map.suggested.json, save it as stage_map.json.")
        _STAGE_MAP_CACHE = {}
    except Exception as e:
        log.error(f"  stage_map.json unreadable ({e}) — orders stay at 'booked'.")
        _STAGE_MAP_CACHE = {}
    return _STAGE_MAP_CACHE


def _stage_for(section, code):
    if code is None:
        return None
    entry = stage_map().get(section, {}).get(str(code))
    if isinstance(entry, dict):
        return entry.get("stage")
    return entry if isinstance(entry, str) else None


def decorate_orders_with_stage(orders):
    """Stamp each order with the Eclat stage its OrderStatus decodes to."""
    for o in orders:
        stage = _stage_for("orderStatusToStage", o.get("OrderStatus"))
        if stage:
            o["EclatStage"] = stage
    return orders


def extract_bags(cursor, since=""):
    """Shop-floor bags = SPM_BagMaster (→ Eclat ProductionBag).

    Joined to SPM_DepartmentMst so Eclat stores a department NAME ("Polishing")
    rather than an opaque id, and stamped with the mapped Eclat stage so the
    backend can advance each order to the furthest point its bags have reached.
    """
    if not table_columns(cursor, "SPM_BagMaster"):
        log.info("  SPM_BagMaster not present — no manufacturing timeline on this install")
        return []
    bags = _base(cursor, "SPM_BagMaster", since)

    # Department id -> name, so the timeline reads in words.
    names = {}
    if table_columns(cursor, "SPM_DepartmentMst"):
        try:
            cursor.execute("SELECT * FROM SPM_DepartmentMst")
            for r in rows(cursor):
                did = r.get("DepartmentId") or r.get("Id")
                nm = (r.get("DepartmentName") or r.get("Department")
                      or r.get("Name") or r.get("Descr"))
                if did is not None and nm:
                    names[str(did)] = str(nm).strip()
        except Exception as e:
            log.warning(f"  department names unavailable: {e}")

    for b in bags:
        did = b.get("DepartmentId")
        if did is not None and str(did) in names:
            b["DepartmentName"] = names[str(did)]
        stage = _stage_for("departmentToStage", did)
        if stage:
            b["EclatStage"] = stage
    return bags


def extract_payments(cursor, since=""):
    """Day-book ledger movements = Journal (→ Eclat Payment / LedgerEntry). Double
    entry: DrAccountNo / CrAccountNo are PartyMst ledger accounts. Append-heavy, no
    UpdateDate — watermark on EntryDate / identity Id. ~475 rows.
    NOTE: cash/bank receipts with a payment MODE live in VoucherEntry (only 13 rows in
    the restored copy). Journal is the authoritative day-book here, so we sync it as the
    payment/ledger source; add a VoucherEntry extractor if the live DB uses receipts.
    # LIVE-DB: confirm whether the client books receipts in VoucherEntry vs Journal."""
    return _base(cursor, "Journal", since)


# ── Production sink: per-entity bulk-upsert to the Eclat REST API ──────────────
def _json_default(o):
    """JSON-serialise pyodbc values: datetime/date -> ISO, Decimal -> float, else str."""
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    return str(o)


def push_chunked(token, base_url, entity, records, label="sync"):
    """POST records to POST /sync/<entity> in 3000-row chunks (the backend upserts
    on legacyId). Returns (ok, watermark): `ok` is True only if EVERY chunk got a
    2xx — so a failure leaves the watermark un-advanced and the rows retry next
    run. `watermark` is the max legacy UpdateDate/EntryDate the backend saw."""
    if not records:
        log.info(f"  {label}: no {entity} data")
        return True, None
    chunk_size, total = 3000, len(records)
    chunks = (total + chunk_size - 1) // chunk_size
    url = f"{base_url}/sync/{entity}"
    hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    all_ok, watermark = True, None
    for i in range(0, total, chunk_size):
        chunk = records[i:i + chunk_size]
        part = (i // chunk_size) + 1
        tag = f"{entity} ({part}/{chunks})" if chunks > 1 else entity
        try:
            payload = json.dumps({"records": chunk}, default=_json_default)
            log.info(f"  Pushing {tag}: {len(chunk)} rows...")
            r = requests.post(url, headers=hdrs, data=payload, timeout=180)
            if 200 <= r.status_code < 300:
                try:
                    resp = r.json()
                    wm = resp.get("watermark") if isinstance(resp, dict) else None
                    if wm and (watermark is None or wm > watermark):
                        watermark = wm
                    log.info(f"  {tag}: upserted={resp.get('upserted')} skipped={resp.get('skipped')}")
                except Exception:
                    pass
            else:
                log.error(f"  {tag}: FAILED {r.status_code}: {r.text[:200]}")
                all_ok = False
        except Exception as e:
            log.error(f"  {tag}: error: {e}")
            all_ok = False
    return all_ok, watermark


def push_stores(cursor, token, base_url):
    """Push the store/branch CATALOG to POST /sync/stores so a new branch created in
    the client's Gati (APRS-SJEP) flows into Eclat automatically: new legacyIds land
    as *pending* stores (awaiting HO/AM activation), existing ones just refresh
    name/city/code. Idempotent + safe to re-run — the backend upserts keyed on
    legacyId, same head_office / sync-token auth as the other /sync/* pushes.

    A branch/location in the legacy schema is a PartyMst row flagged as a
    location/factory (docs/legacy-schema.md role bits: IsLocation / IsFactory).
    Unlike the transaction extractors this runs its OWN full pull every cycle (no
    watermark): the store catalog is tiny and must be COMPLETE each run so a branch
    is never missed. Non-fatal by contract — callers wrap in try/except and continue.
    """
    cols = table_columns(cursor, "PartyMst")
    if not cols:
        log.warning(f"  [{base_url}] stores: PartyMst not found — skipping")
        return

    # LIVE-DB: BRANCH-DETECTION PREDICATE — CONFIRM BEFORE FIRST RUN.
    # The schema notes model a store/branch as a PartyMst row with a location flag
    # (role bits IsLocation / IsFactory). Confirm on the CLIENT'S LIVE install which
    # flag actually marks a sellable branch vs an internal factory/godown — some
    # APRS-SJEP versions set only IsLocation, some also set IsFactory, and the flag
    # column names can differ by version. Best-effort: match whichever of these
    # flags exists; if NEITHER exists we bail rather than mass-import every party as
    # a store. (Also consider excluding cancelled/inactive rows if the live schema
    # carries an IsActive/IsBlackList flag on locations.)
    flag_preds = []
    if "islocation" in cols:
        flag_preds.append("t.IsLocation = 1")
    if "isfactory" in cols:
        flag_preds.append("t.IsFactory = 1")
    if not flag_preds:
        log.warning(f"  [{base_url}] stores: no IsLocation/IsFactory flag on PartyMst — "
                    f"cannot detect branches; skipping (# LIVE-DB: confirm branch flag)")
        return

    # LIVE-DB: SOURCE COLUMN NAMES — CONFIRM BEFORE FIRST RUN.
    # PartyNo (varchar PK) -> legacyId; FirmName -> name; FirmCity -> city;
    # PartyCode -> code. Confirm these are the right columns on the live schema.
    # We SELECT only columns that actually exist so a version missing PartyCode /
    # FirmCity never errors (schema-defensive, same as the other extractors).
    pk_col   = cols.get("partyno")
    name_col = cols.get("firmname") or cols.get("legalname")
    city_col = cols.get("firmcity")
    code_col = cols.get("partycode")
    if not pk_col or not name_col:
        log.warning(f"  [{base_url}] stores: PartyMst missing PartyNo/FirmName — skipping")
        return

    sel = [f"t.{pk_col} AS legacyId", f"t.{name_col} AS name"]
    if city_col:
        sel.append(f"t.{city_col} AS city")
    if code_col:
        sel.append(f"t.{code_col} AS code")
    where = " OR ".join(flag_preds)
    # Best-effort query (READ-ONLY). Marked columns/predicate above pending confirmation.
    cursor.execute(f"SELECT {', '.join(sel)} FROM PartyMst t WHERE {where}")
    raw = rows(cursor)

    # Map each location row to the /sync/stores contract: {legacyId, name, city?, code?}
    records = []
    for r in raw:
        lid = r.get("legacyId")
        if lid is None or str(lid).strip() == "":
            continue
        rec = {"legacyId": str(lid).strip(), "name": str(r.get("name") or "").strip()}
        if r.get("city") is not None and str(r.get("city")).strip():
            rec["city"] = str(r.get("city")).strip()
        if r.get("code") is not None and str(r.get("code")).strip():
            rec["code"] = str(r.get("code")).strip()
        records.append(rec)

    if not records:
        log.info(f"  [{base_url}] stores: no branch/location rows matched")
        return

    url  = f"{base_url}/sync/stores"
    hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        payload = json.dumps({"records": records}, default=_json_default)
        log.info(f"  [{base_url}] pushing stores: {len(records)} branch/location rows...")
        r = requests.post(url, headers=hdrs, data=payload, timeout=120)
        if 200 <= r.status_code < 300:
            try:
                resp = r.json() if isinstance(r.json(), dict) else {}
            except Exception:
                resp = {}
            created = resp.get("created", resp.get("createdCount", "?"))
            updated = resp.get("updated", resp.get("updatedCount", "?"))
            log.info(f"  [{base_url}] stores: created={created} updated={updated} (sent {len(records)})")
        else:
            log.error(f"  [{base_url}] stores: FAILED {r.status_code}: {r.text[:200]}")
    except Exception as e:
        log.error(f"  [{base_url}] stores: error: {e}")


def run_test():
    """Verify backend login + SQL Server connect BEFORE scheduling."""
    log.info("=" * 50); log.info("CONNECTION TEST"); ok = True
    log.info(f"Targets: {', '.join(BACKENDS)}")
    for base_url in BACKENDS:
        if login(base_url): log.info(f"[OK]  Eclat login: {base_url}")
        else: log.error(f"[FAIL] Eclat login: {base_url} — check URL / email / password"); ok = False
    conn = connect_sql()
    if conn:
        log.info("[OK]  SQL Server connected"); conn.close()
    else:
        log.error("[FAIL] SQL Server — check driver / server / credentials / read-only login"); ok = False
    log.info("RESULT: " + ("TEST PASSED" if ok else "TEST FAILED")); log.info("=" * 50)
    return ok


# ── Generic FULL MIRROR: dump EVERY table to /sync/raw (extract-everything-once) ──
# So that ANY field/table the client ever needs is already in Eclat, with no code
# change. Each table is incremental (UpdateDate/EntryDate) and self-healing: a table
# that errors is skipped, never fatal.
def list_tables(cursor):
    """Every base table in the DB (skips views + system tables)."""
    cursor.execute(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
        "WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
    )
    return [r[0] for r in cursor.fetchall()]


def pk_columns(cursor, table):
    """Primary-key column names for `table`, in order — used for a stable row key."""
    try:
        cursor.execute(
            "SELECT c.COLUMN_NAME "
            "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t "
            "JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE c "
            "  ON t.CONSTRAINT_NAME=c.CONSTRAINT_NAME AND t.TABLE_SCHEMA=c.TABLE_SCHEMA "
            "WHERE t.CONSTRAINT_TYPE='PRIMARY KEY' AND t.TABLE_NAME=? "
            "ORDER BY c.ORDINAL_POSITION",
            table,
        )
        return [r[0] for r in cursor.fetchall()]
    except Exception:
        return []


def _row_key(row, pks):
    """Stable per-row key: the PK values joined, else an MD5 of the whole row."""
    if pks:
        return "|".join(str(row.get(c)) for c in pks)
    blob = json.dumps(row, default=_json_default, sort_keys=True)
    return hashlib.md5(blob.encode("utf-8")).hexdigest()


def push_raw(token, base_url, table, records, chunk_size=1500):
    """POST raw rows to POST /sync/raw in chunks (SELECT * rows are wide, so a
    smaller chunk keeps payloads under the body limit). Returns (ok, watermark)."""
    if not records:
        return True, None
    url = f"{base_url}/sync/raw"
    hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    all_ok, watermark = True, None
    for i in range(0, len(records), chunk_size):
        chunk = records[i:i + chunk_size]
        try:
            payload = json.dumps({"table": table, "records": chunk}, default=_json_default)
            r = requests.post(url, headers=hdrs, data=payload, timeout=300)
            if 200 <= r.status_code < 300:
                try:
                    wm = r.json().get("watermark")
                    if wm and (watermark is None or wm > watermark):
                        watermark = wm
                except Exception:
                    pass
            else:
                log.error(f"    raw {table}: FAILED {r.status_code}: {r.text[:150]}")
                all_ok = False
        except Exception as e:
            log.error(f"    raw {table}: error: {e}")
            all_ok = False
    return all_ok, watermark


def dump_all(cursor, token, base_url, state):
    """Mirror EVERY table to LegacyRow via /sync/raw — the extract-everything-once
    sink. Incremental per-table (state key 'raw::<base>::<table>'). Errors per table
    are logged and skipped so one bad table never blocks the rest."""
    tables = list_tables(cursor)
    log.info(f"  [{base_url}] full mirror: scanning {len(tables)} tables")
    scanned = pushed = 0
    for tbl in tables:
        skey = f"raw::{base_url}::{tbl}"
        since = state.get(skey, "")
        try:
            wm_clause, n = _wm(cursor, tbl)
            cursor.execute(f"SELECT * FROM [{tbl}] t WHERE {wm_clause}", *([since] * n))
            recs = rows(cursor)
        except Exception as e:
            log.warning(f"    raw {tbl}: skip ({str(e)[:90]})")
            continue
        scanned += 1
        if not recs:
            continue
        pks = pk_columns(cursor, tbl)
        for r in recs:
            r["_rowKey"] = _row_key(r, pks)
            r["_updatedAt"] = r.get("UpdateDate") or r.get("EntryDate")
        ok, wm = push_raw(token, base_url, tbl, recs)
        if ok:
            pushed += 1
            if wm and (not since or wm > since):
                state[skey] = wm
                save_state(state)
    log.info(f"  [{base_url}] full mirror done: scanned={scanned}, {pushed} tables had new rows")


def sync_once():
    log.info("=" * 50)
    log.info(f"Sync started at {datetime.now():%Y-%m-%d %H:%M:%S}")
    log.info(f"Targets: {', '.join(BACKENDS)}")
    conn = connect_sql()
    if not conn:
        return
    state = load_state()
    try:
        cursor = conn.cursor()
        # Push the SAME read-only data to EVERY configured backend (local + prod).
        # Each target keeps its OWN watermark, so one being down never blocks another.
        for base_url in BACKENDS:
            token = login(base_url)
            if not token:
                log.error(f"  [{base_url}] login failed — skipping (retries next run)")
                continue
            since = state.get(base_url, "")
            log.info(f"  [{base_url}] since: {since or '(full backfill)'}")

            # STORE CATALOG FIRST — a new branch created in the client's Gati must
            # exist in Eclat BEFORE the parties/stock/sales that reference it sync.
            # Non-fatal: a store-push failure logs and continues (same reliability
            # posture as the full mirror below). No watermark — full idempotent
            # upsert every run.
            # NEXT STEP (not this change): per-row location -> store stamping. Today
            # transaction rows still ride the single backend defaultStoreId; once the
            # branch-detection predicate above is confirmed against the live schema,
            # stamp each party/stock/sale row with its LocationId -> Eclat storeId.
            try:
                push_stores(cursor, token, base_url)
            except Exception as e:
                log.error(f"  [{base_url}] stores push error: {e}")

            parties = extract_parties(cursor, since)
            items   = extract_items(cursor, since)
            stock   = extract_stock(cursor, since)
            sales   = extract_sales(cursor, since)
            lines   = extract_sale_lines(cursor, [s["JewelTransId"] for s in sales])
            orders  = decorate_orders_with_stage(extract_orders(cursor, since))
            oitems  = extract_order_items(cursor, [o["OrderId"] for o in orders])
            bags    = extract_bags(cursor, since)
            payments = extract_payments(cursor, since)
            log.info(f"  [{base_url}] extracted: parties={len(parties)} items={len(items)} "
                     f"stock={len(stock)} sales={len(sales)}({len(lines)} lines) "
                     f"orders={len(orders)}({len(oitems)} items) bags={len(bags)} "
                     f"payments={len(payments)}")

            # Masters before rows that reference them (FK resolution on the backend).
            batches = [
                ("parties", parties),
                ("products", items),
                ("stock", stock),
                ("sales", sales),
                ("sale-lines", lines),
                ("orders", orders),
                ("order-items", oitems),
                # Last: bags advance the order headers pushed just above, so the
                # orders must already exist for the backend to resolve them.
                ("bags", bags),
            ]
            all_ok, new_wm = True, since
            for entity, recs in batches:
                ok, wm = push_chunked(token, base_url, entity, recs)
                all_ok = all_ok and ok
                if wm and (not new_wm or wm > new_wm):
                    new_wm = wm

            if all_ok:
                if new_wm and new_wm != since:
                    state[base_url] = new_wm
                    save_state(state)
                    log.info(f"  [{base_url}] watermark advanced to {new_wm}")
                else:
                    log.info(f"  [{base_url}] no new rows — watermark unchanged")
            else:
                log.error(f"  [{base_url}] some uploads failed — watermark NOT advanced; retries next cycle")

            # FULL RAW MIRROR — dump every table so ANY field is available later,
            # with no code change. Independent of the mapped sync above; its own
            # per-table watermarks mean it only ships changed rows after the first run.
            try:
                dump_all(cursor, token, base_url, state)
            except Exception as e:
                log.error(f"  [{base_url}] full mirror error: {e}")
    finally:
        conn.close()
    log.info("Sync complete"); log.info("=" * 50)


if __name__ == "__main__":
    import argparse, time
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", type=int, default=0, help="run every X minutes (0=once)")
    ap.add_argument("--test", action="store_true", help="test connectivity then exit")
    args = ap.parse_args()
    if args.test:
        sys.exit(0 if run_test() else 1)
    if args.loop > 0:
        log.info(f"Auto Sync — every {args.loop} min. Ctrl+C to stop.")
        while True:
            try: sync_once()
            except Exception as e: log.error(f"Error: {e}")
            log.info(f"Next sync in {args.loop} min...")
            time.sleep(args.loop * 60)
    else:
        sync_once()
