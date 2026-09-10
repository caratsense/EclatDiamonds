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
import re
import requests
from datetime import datetime, date
from decimal import Decimal
from gati_machine_auth import (
    GatiAuthError,
    approved_connection,
    approval_summary,
)
from gati_runtime import (
    GatiRunAlreadyActive,
    atomic_write_json,
    install_run_lock,
)
from gati_target_safety import TargetSafetyError, require_approved_backend

# ── Configuration (from environment or eclat_config.bat) ──
# One enrolled agent belongs to one backend/tenant. Use a separate installation
# and token for another environment; never reuse a production credential in dev.
BACKENDS    = [u.strip().rstrip("/") for u in os.getenv("ECLAT_BASE_URL", "").split(",") if u.strip()]
AGENT_TOKEN = os.getenv("CARATOS_AGENT_TOKEN", "").strip()
APPROVED_BACKEND = os.getenv("CARATOS_APPROVED_BACKEND_ORIGIN", "").strip()
# SQL Server connection — live, READ-ONLY. Use a least-privilege read-only login.
SQL_SERVER  = os.getenv("SJEP_SQL_SERVER", r"localhost\SQLEXPRESS")
SQL_DB      = os.getenv("SJEP_SQL_DB", "APRSSJEP")
SQL_USER    = os.getenv("SJEP_SQL_USER", "")          # blank => Windows auth
SQL_PASS    = os.getenv("SJEP_SQL_PASS", "")

# A dry run only READS the client's database and uploads nothing, so it must be
# usable before the Eclat account exists — that is exactly when you want to check
# what is in there. Everything else needs credentials up front.
# --help must also bypass the guard, or the user cannot discover the flags that
# would let them run without credentials.
_DRY = any(a in sys.argv for a in ("--dry-run", "--help", "-h"))
if not _DRY and (not BACKENDS or not AGENT_TOKEN):
    print("ERROR: CaratOS Connect settings not set. Run this through a .bat so eclat_config.bat loads.")
    print("       Enrol an organisation-wide Gati agent and set CARATOS_AGENT_TOKEN.")
    print("       (A dry run works without them:  python sync_sjep.py --dry-run)")
    sys.exit(1)
if not _DRY and len(BACKENDS) != 1:
    print("ERROR: a Gati Connect token can target exactly one backend installation.")
    print("       Use a separate installation and enrolled token for another environment.")
    sys.exit(1)
if not _DRY:
    try:
        BACKENDS = [require_approved_backend(BACKENDS[0], APPROVED_BACKEND)]
    except TargetSafetyError as exc:
        print(f"[SAFETY STOP] {exc}")
        print("       Rerun 2_configure.bat and review the exact backend before any networked command.")
        sys.exit(20)
if _DRY and not BACKENDS:
    # One placeholder pass so the inspection loop runs with nothing configured.
    BACKENDS = ["(dry-run: no backend configured)"]

# Per-target watermark (JSON: { base_url: last_synced_iso }) so each backend
# (local + production) advances independently — one offline never blocks the others.
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_state.json")
LOG_DIR    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE   = os.path.join(LOG_DIR, "auto_sync.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("eclat-sync")
APPROVAL_HEADERS = {}
HEARTBEATS = {}
CHECKPOINT_CONTEXTS = {}

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# ── Watermark: per-target last-synced marker so we only push NEW data ──
def load_state():
    """Read durable checkpoints, failing closed on corruption.

    Treating malformed JSON as an empty state silently starts a full 1,000-table
    replay and can overwrite a concurrently written checkpoint.  The operator
    must see and recover a damaged file explicitly instead.
    """
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            value = json.load(f)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "sync_state.json is unreadable; keep it for recovery and contact support"
        ) from exc
    if not isinstance(value, dict):
        raise RuntimeError("sync_state.json must contain a JSON object")
    return value


def save_state(state):
    try:
        atomic_write_json(STATE_FILE, state)
        return True
    except Exception as e:
        log.error(f"Could not save state: {e}")
        return False


MAPPED_SOURCES = (
    "parties",
    "products",
    "stock",
    "sales",
    "sale-lines",
    "orders",
    "order-items",
    "bags",
    "ledger",
    "stock-movements",
)
MAPPED_DEPENDENCIES = {
    "sales": ("sales", "sale-lines"),
    "sale-lines": ("sales", "sale-lines"),
    "orders": ("orders", "order-items"),
    "order-items": ("orders", "order-items"),
}


def _checkpoint_context(base_url):
    """Freeze the exact approved backend/profile/source/config generation."""
    context = CHECKPOINT_CONTEXTS.get(base_url)
    if context:
        return dict(context)
    headers = APPROVAL_HEADERS.get(base_url) or {}
    required = {
        "backend": base_url.strip().rstrip("/").casefold(),
        "profileHash": headers.get("x-caratos-profile-hash"),
        "sourceInstanceHash": headers.get("x-caratos-source-instance-hash"),
        "configRevision": headers.get("x-caratos-config-revision"),
    }
    if not all(isinstance(value, str) and value for value in required.values()):
        raise RuntimeError("no approved checkpoint generation is available")
    return required


def checkpoint_namespace(base_url):
    context = _checkpoint_context(base_url)
    encoded = json.dumps(
        context, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("ascii")
    return "gati-v2::" + hashlib.sha256(encoded).hexdigest()


def mapped_state_key(base_url, source):
    return f"{checkpoint_namespace(base_url)}::mapped::{source}"


def raw_state_key(base_url, table):
    return f"{checkpoint_namespace(base_url)}::raw::{table}"


def _remember_checkpoint_context(state, base_url):
    namespace = checkpoint_namespace(base_url)
    state[f"{namespace}::context"] = _checkpoint_context(base_url)


def mapped_watermarks(state, base_url):
    """Per-source boundaries; never fan an old global maximum into all sources."""
    return {
        source: str(state.get(mapped_state_key(base_url, source), "") or "")
        for source in MAPPED_SOURCES
    }


def advance_mapped_watermarks(state, base_url, batch_ok, batch_watermarks):
    """Advance only sources whose complete dependency group was acknowledged.

    Sale lines are selected using the changed sale-header IDs, so their durable
    boundary is the sale header's watermark. Order items follow the same rule.
    If either child upload fails, the parent boundary stays put and both retry.
    """
    changed = False
    for source in MAPPED_SOURCES:
        dependencies = MAPPED_DEPENDENCIES.get(source, (source,))
        if not all(batch_ok.get(entity) is True for entity in dependencies):
            continue
        watermark = batch_watermarks.get(source)
        if not isinstance(watermark, str) or not watermark:
            continue
        key = mapped_state_key(base_url, source)
        previous = str(state.get(key, "") or "")
        if not previous or watermark > previous:
            state[key] = watermark
            changed = True
    if changed:
        _remember_checkpoint_context(state, base_url)
    return changed


# ── Connections ──
def login(base_url):
    try:
        headers, reporter = approved_connection(
            base_url, AGENT_TOKEN, SQL_SERVER, SQL_DB
        )
        APPROVAL_HEADERS[base_url] = headers
        HEARTBEATS[base_url] = reporter
        CHECKPOINT_CONTEXTS[base_url] = _checkpoint_context(base_url)
        log.info(f"Restricted Gati agent approved: {base_url}")
        return AGENT_TOKEN
    except GatiAuthError as e:
        log.error(f"Gati agent approval failed ({base_url}): {e}")
    except Exception:
        log.error(f"Gati agent approval failed ({base_url}): unexpected handshake error")
    return None


def heartbeat(base_url, phase, **stats):
    """Cheap call-site hook; the shared reporter throttles actual requests."""
    reporter = HEARTBEATS.get(base_url)
    if reporter is not None:
        reporter.periodic({"phase": phase, **stats})


def terminal_heartbeat(base_url, ok, error=None, **stats):
    """Best-effort terminal status that never masks the actual run result."""
    reporter = HEARTBEATS.get(base_url)
    if reporter is None:
        return False
    try:
        payload = {"phase": "complete" if ok else "failed", **stats}
        if ok:
            reporter.success(payload)
        else:
            reporter.error(error or "Gati sync failed", payload)
        return True
    except Exception:
        log.error(f"  [{base_url}] could not report terminal agent status")
        return False


def sync_headers(base_url):
    headers = APPROVAL_HEADERS.get(base_url)
    if not headers:
        raise RuntimeError("restricted Gati agent handshake has not completed")
    frozen = CHECKPOINT_CONTEXTS.get(base_url)
    if frozen and headers.get("x-caratos-config-revision") != frozen.get(
        "configRevision"
    ):
        raise RuntimeError(
            "head office changed the connector configuration during this run; "
            "nothing further was uploaded and the next run will restart safely"
        )
    return dict(headers)


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
    except Exception as exc:
        # Optional modules genuinely may not exist across APRS versions. Only
        # that SQL Server condition is an empty schema; a timeout, permission or
        # broken connection is an extraction failure and must reach exit status.
        message = str(exc)
        if "42S02" in message or re.search(r"\bInvalid object name\b", message, re.I):
            return {}
        raise


# ── Extractors — REAL SQL against the APRS-SJEP schema ──
# Every transaction table has an identity-bigint PK (monotonic, best for NEW rows)
# plus EntryDate/UpdateDate (for CHANGED rows). The incremental filter is:
#     UpdateDate >= @since  OR  (UpdateDate IS NULL AND EntryDate >= @since)
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


def _wm(cursor, table, since="", until=None):
    """Return a bounded, overlap-safe watermark predicate and its parameters.

    ``>=`` deliberately replays rows tied at the saved timestamp; every sink is
    an idempotent legacy-key upsert. ``until`` is captured from SQL Server once
    per run, so a malformed future source date can never become the checkpoint.
    """
    c = table_columns(cursor, table)
    upd = "updatedate" in c
    ent = "entrydate" in c
    if upd and ent:
        value = "COALESCE(t.UpdateDate, t.EntryDate)"
        return (
            f"(? = '' OR {value} >= CONVERT(datetime, ?)) "
            f"AND (? IS NULL OR {value} IS NULL OR {value} <= CONVERT(datetime, ?))",
            [since, since, until, until],
        )
    if ent:
        return (
            "(? = '' OR t.EntryDate >= CONVERT(datetime, ?)) "
            "AND (? IS NULL OR t.EntryDate IS NULL OR t.EntryDate <= CONVERT(datetime, ?))",
            [since, since, until, until],
        )
    if upd:
        return (
            "(? = '' OR t.UpdateDate >= CONVERT(datetime, ?)) "
            "AND (? IS NULL OR t.UpdateDate IS NULL OR t.UpdateDate <= CONVERT(datetime, ?))",
            [since, since, until, until],
        )
    return ("1=1", [])


def _base(cursor, table, since, until=None):
    """SELECT * from a base table with the adaptive watermark. SELECT * never
    fails on a missing column and pulls EVERY available field."""
    if not table_columns(cursor, table):
        return []
    wm, params = _wm(cursor, table, since, until)
    cursor.execute(f"SELECT * FROM {table} t WHERE {wm}", *params)
    return rows(cursor)


def _ident(value):
    """Quote a SQL Server identifier obtained from trusted schema metadata."""
    return "[" + str(value).replace("]", "]]" ) + "]"


def _dedupe_rows(records):
    """Remove overlap between timestamp- and parent-triggered source reads."""
    output, seen = [], set()
    for record in records:
        marker = json.dumps(
            record, default=_json_default, sort_keys=True, separators=(",", ":")
        )
        if marker in seen:
            continue
        seen.add(marker)
        output.append(record)
    return output


def _has_watermark_columns(columns):
    return "updatedate" in columns or "entrydate" in columns


def _select_by_values(cursor, table, column, values, until=None):
    """Select rows in bounded IN chunks (SQL Server allows only 2,100 params)."""
    unique = list(dict.fromkeys(value for value in values if value is not None))
    if not unique:
        return []
    selected = []
    for offset in range(0, len(unique), 1000):
        chunk = unique[offset:offset + 1000]
        placeholders = ",".join("?" for _ in chunk)
        wm, wm_params = _wm(cursor, table, "", until)
        cursor.execute(
            f"SELECT * FROM {_ident(table)} t WHERE "
            f"t.{_ident(column)} IN ({placeholders}) AND ({wm})",
            *chunk,
            *wm_params,
        )
        selected.extend(rows(cursor))
    return selected


def _changed_dependency_values(cursor, table, key, since, until):
    """Return dependency key -> latest change, or ``None`` for a full fallback."""
    columns = table_columns(cursor, table)
    if not columns:
        return set()
    actual_key = columns.get(str(key).lower())
    if not actual_key:
        log.warning(f"  {table}: dependency key {key} is absent; cannot trigger parents")
        return set()
    if not since:
        return set()
    if not _has_watermark_columns(columns):
        return None
    wm, params = _wm(cursor, table, since, until)
    update_column = columns.get("updatedate")
    entry_column = columns.get("entrydate")
    if update_column and entry_column:
        changed_at = (
            f"COALESCE(t.{_ident(update_column)}, t.{_ident(entry_column)})"
        )
    else:
        changed_at = f"t.{_ident(update_column or entry_column)}"
    cursor.execute(
        f"SELECT t.{_ident(actual_key)} AS DependencyKey, "
        f"MAX({changed_at}) AS DependencyChangedAt "
        f"FROM {_ident(table)} t WHERE {wm} "
        f"GROUP BY t.{_ident(actual_key)}",
        *params,
    )
    return {
        row.get("DependencyKey"): row.get("DependencyChangedAt")
        for row in rows(cursor)
        if row.get("DependencyKey") is not None
    }


def _dependency_aware_base(
    cursor, parent_table, parent_key, since="", until=None, dependencies=()
):
    """Read changed parents plus parents affected by child/lookup changes.

    Each dependency is ``(table, dependency_key, parent_reference_column)``.
    A dependency without its own timestamp forces a safe full parent read rather
    than silently missing a summary or lookup-only edit.
    """
    parent_columns = table_columns(cursor, parent_table)
    if not parent_columns:
        return []
    base = _base(cursor, parent_table, since, until)
    if not since:
        return base

    extra = []
    for dependency_table, dependency_key, parent_reference in dependencies:
        actual_parent_reference = parent_columns.get(parent_reference.lower())
        if not actual_parent_reference:
            continue
        changed = _changed_dependency_values(
            cursor, dependency_table, dependency_key, since, until
        )
        if changed is None:
            log.info(
                f"  {dependency_table}: no change timestamp; rereading all "
                f"{parent_table} rows to preserve dependency updates"
            )
            return _base(cursor, parent_table, "", until)
        affected = _select_by_values(
            cursor,
            parent_table,
            actual_parent_reference,
            changed.keys(),
            until,
        )
        # A lookup-only edit (for example BookMaster changing a sale's branch)
        # must move the mapped source boundary too.  Otherwise the corrected
        # parent is captured but replayed forever because its own date is old.
        for parent in affected:
            changed_at = changed.get(parent.get(actual_parent_reference))
            if changed_at is not None:
                _carry_dependency_change(parent, {"UpdateDate": changed_at})
        extra.extend(affected)
    return _dedupe_rows(base + extra)


def _extract_child_rows(
    cursor, table, parent_column, changed_parent_ids, since="", until=None
):
    """Capture both child-only edits and all children of changed parents."""
    columns = table_columns(cursor, table)
    if not columns:
        return []
    actual_parent = columns.get(parent_column.lower())
    if not actual_parent:
        raise RuntimeError(f"{table} has no required {parent_column} column")

    if not since:
        return _base(cursor, table, "", until)
    if not _has_watermark_columns(columns):
        log.info(
            f"  {table}: no child change timestamp; rereading all rows safely"
        )
        return _base(cursor, table, "", until)

    changed_children = _base(cursor, table, since, until)
    parent_children = _select_by_values(
        cursor, table, actual_parent, changed_parent_ids, until
    )
    return _dedupe_rows(changed_children + parent_children)


def _change_value(record):
    """Return the same source-change value the backend uses for a watermark."""
    by_name = {str(name).lower(): value for name, value in record.items()}
    return by_name.get("updatedate") or by_name.get("entrydate")


def _change_sort_key(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value).strip()


def _carry_dependency_change(target, dependency):
    """Make a summary/lookup-only edit visible to the backend watermark.

    The API calculates its receipt from ``UpdateDate`` else ``EntryDate`` on the
    outgoing row.  If a joined summary changed after its unchanged parent, keep
    the later timestamp on the mapped record; otherwise the summary would be
    resent forever and its source checkpoint could never advance.
    """
    candidate = _change_value(dependency)
    current = _change_value(target)
    if candidate is not None and (
        current is None or _change_sort_key(candidate) > _change_sort_key(current)
    ):
        target["UpdateDate"] = candidate


def _merge_1to1(cursor, base_rows, table, key, until=None):
    """Merge a 1:1 summary table (e.g. InwardSummary) into base_rows on `key`.
    Adds summary columns not already present (base wins on a name clash)."""
    cols = table_columns(cursor, table)
    if not base_rows or not cols or key.lower() not in cols:
        return
    wm, params = _wm(cursor, table, "", until)
    cursor.execute(f"SELECT * FROM {_ident(table)} t WHERE {wm}", *params)
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
            _carry_dependency_change(b, s)


def _merge_lookup(cursor, base_rows, table, base_key, lookup_key, want, until=None):
    """Merge selected columns from a lookup table (e.g. ToneMst) into base_rows,
    matching base_rows[base_key] == lookup[lookup_key]."""
    cols = table_columns(cursor, table)
    if not base_rows or not cols or lookup_key.lower() not in cols:
        return
    wm, params = _wm(cursor, table, "", until)
    cursor.execute(f"SELECT * FROM {_ident(table)} t WHERE {wm}", *params)
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
            _carry_dependency_change(b, l)


def extract_parties(cursor, since="", until=None):
    """Customers / suppliers / salespersons / branches — PartyMst master (SELECT *,
    every field). Branch/location rows become Eclat Stores; role flags -> Party.types."""
    return _base(cursor, "PartyMst", since, until)


def extract_items(cursor, since="", until=None):
    """Designs = StyleMst (+ StyleMstSummary 1:1 weights/amounts, + ToneMst metal)."""
    items = _dependency_aware_base(
        cursor,
        "StyleMst",
        "StyleId",
        since,
        until,
        (
            ("StyleMstSummary", "StyleId", "StyleId"),
            ("ToneMst", "ToneNo", "MetalToneNo"),
        ),
    )
    _merge_1to1(cursor, items, "StyleMstSummary", "StyleId", until)
    _merge_lookup(
        cursor,
        items,
        "ToneMst",
        "MetalToneNo",
        "ToneNo",
        ["ToneCode", "ToneFor"],
        until,
    )
    return items


def extract_stock(cursor, since="", until=None):
    """Per-piece stock = Inward (+ InwardSummary 1:1 weights/amounts, + ToneMst metal).
    SELECT * so a missing column (e.g. MRP on some versions) never crashes the pull."""
    stock = _dependency_aware_base(
        cursor,
        "Inward",
        "JewelId",
        since,
        until,
        (
            ("InwardSummary", "JewelId", "JewelId"),
            ("ToneMst", "ToneNo", "MetalToneNo"),
        ),
    )
    _merge_1to1(cursor, stock, "InwardSummary", "JewelId", until)
    _merge_lookup(
        cursor,
        stock,
        "ToneMst",
        "MetalToneNo",
        "ToneNo",
        ["ToneCode", "ToneFor"],
        until,
    )
    return stock


def extract_stock_movements(cursor, since="", until=None):
    """Per-piece movement log = InwardHistory (→ Eclat StockMovement).

    Says which piece moved, what it became (`Jstatus`, the same letters the stock
    import decodes) and when. Append-only, so the watermark rides on Id like the
    day book. 14,374 rows on the client's live database, and until now nothing
    read them — "when did this ring reach Bandra, and where was it before" simply
    had no answer in the product.

    `LocationId` is NULL throughout on this install, so from/to branch cannot be
    filled and is deliberately left null rather than guessed."""
    return _base(cursor, "InwardHistory", since, until)


def extract_sales(cursor, since="", until=None):
    """Invoice headers = JewelTrans (SELECT *). Lines via extract_sale_lines().
    TranType selects the doc kind (sale/purchase/branch transfer/proforma/return)."""
    return _dependency_aware_base(
        cursor,
        "JewelTrans",
        "JewelTransId",
        since,
        until,
        (("BookMaster", "BookNo", "BookNo"),),
    )


def extract_sale_lines(cursor, trans_ids, since="", until=None):
    """Per-line component-priced snapshot for a set of JewelTransIds.
    JewelTransInward = the line (a JewelId on a bill); JewelTransInwardSummary = its
    weight/amount rollup. (JewelTransInward has no own identity — keyed by parent.)
    Pass the JewelTransIds returned by extract_sales()."""
    line_columns = table_columns(cursor, "JewelTransInward")
    if not line_columns:
        return []
    lines = _extract_child_rows(
        cursor,
        "JewelTransInward",
        "JewelTransId",
        trans_ids,
        since,
        until,
    )
    sc = table_columns(cursor, "JewelTransInwardSummary")
    if lines and sc and "jeweltransid" in sc and "jewelid" in sc:
        if since and not _has_watermark_columns(sc):
            # A summary-only edit cannot be discovered from the line timestamp.
            # Full fallback is the only safe contract on this schema variant.
            lines = _base(cursor, "JewelTransInward", "", until)
        elif since:
            changed_summaries = _base(
                cursor, "JewelTransInwardSummary", since, until
            )
            changed_pairs = {
                (row.get("JewelTransId"), row.get("JewelId"))
                for row in changed_summaries
            }
            changed_trans = {pair[0] for pair in changed_pairs if pair[0] is not None}
            affected = _select_by_values(
                cursor,
                "JewelTransInward",
                line_columns["jeweltransid"],
                changed_trans,
                until,
            )
            lines = _dedupe_rows(
                lines
                + [
                    row
                    for row in affected
                    if (row.get("JewelTransId"), row.get("JewelId"))
                    in changed_pairs
                ]
            )
        summary_trans_ids = {
            line.get("JewelTransId")
            for line in lines
            if line.get("JewelTransId") is not None
        }
        summaries = _select_by_values(
            cursor,
            "JewelTransInwardSummary",
            sc["jeweltransid"],
            summary_trans_ids,
            until,
        )
        by = {}
        for r in summaries:
            by[(r.get("JewelTransId"), r.get("JewelId"))] = r
        for b in lines:
            s = by.get((b.get("JewelTransId"), b.get("JewelId")))
            if s:
                for col, val in s.items():
                    if col not in b:
                        b[col] = val
                _carry_dependency_change(b, s)
    return lines


def extract_orders(cursor, since="", until=None):
    """Manufacturing/custom-production orders = Spm_MfgOrder (→ Eclat
    ManufacturingOrder). Lines = SPM_MfgOrderItem (extract_order_items). OrderStatus is
    an int production stage (decode against legacy status master before trusting in
    Module 8 timelines — # LIVE-DB: confirm OrderStatus codes on the client install).
    ~121 orders."""
    return _dependency_aware_base(
        cursor,
        "Spm_MfgOrder",
        "OrderId",
        since,
        until,
        (("BookMaster", "BookNo", "BookNo"),),
    )


def build_book_branch_map(cursor):
    """BookNo -> branch PartyNo, read off `BookMaster`.

    Why this exists: `JewelTrans` (sales) and `Spm_MfgOrder` (orders) carry NO
    location column at all — the only thing tying a transaction to a place is its
    document book (`BookNo` -> BookMaster), and in this family of systems each
    branch keeps its own invoice/order series. So the book IS the branch, one hop
    away.

    Schema-defensive because the branch column's NAME varies by install: we take
    whichever of the usual candidates exists. Returns {} when BookMaster has no
    branch-ish column, in which case sales/orders simply carry no EclatBranchId
    and the backend reports them as unattributed rather than guessing.

    # LIVE-DB: confirm against discovery_report.txt which column BookMaster
    # actually uses, and that books really are per-branch on this install — some
    # shops keep one series across all branches, in which case transactions
    # cannot be split this way and need a different source.
    """
    cols = table_columns(cursor, "BookMaster")
    if not cols:
        return {}
    pk = cols.get("bookno")
    if not pk:
        return {}
    branch_col = None
    for cand in ("branchno", "locationid", "companyid", "branchid", "partyno"):
        if cand in cols:
            branch_col = cols[cand]
            break
    if not branch_col:
        log.warning("  BookMaster has no branch column — sales/orders cannot be "
                    "attributed to a branch this way (# LIVE-DB: confirm)")
        return {}

    cursor.execute(f"SELECT {pk} AS BookNo, {branch_col} AS BranchNo FROM BookMaster")
    mapping = {}
    for r in rows(cursor):
        b, br = r.get("BookNo"), r.get("BranchNo")
        if b is not None and br is not None and str(br).strip():
            mapping[str(b).strip()] = str(br).strip()
    log.info(f"  BookMaster: {len(mapping)} book(s) map to a branch via {branch_col}")
    return mapping


def stamp_branch(records, book_branch, label=""):
    """Add `EclatBranchId` to rows that have no direct location column.

    The backend checks `EclatBranchId` first for every entity, so this is also the
    hook for overriding attribution on an install whose columns mean something
    unusual — without changing backend code.
    """
    if not records:
        return records
    stamped = 0
    for r in records:
        if r.get("EclatBranchId"):
            continue
        # A direct location on the row always beats the book's branch: it is the
        # more specific fact. Only fill the gap.
        for direct in ("LocationId", "BranchNo"):
            v = r.get(direct)
            if v is not None and str(v).strip():
                r["EclatBranchId"] = str(v).strip()
                stamped += 1
                break
        else:
            bn = r.get("BookNo")
            if bn is not None and str(bn).strip():
                hit = book_branch.get(str(bn).strip())
                if hit:
                    r["EclatBranchId"] = hit
                    stamped += 1
    if label:
        missing = len(records) - sum(1 for r in records if r.get("EclatBranchId"))
        log.info(f"  {label}: {stamped} row(s) tagged with a branch, {missing} without")
    return records


def extract_order_items(cursor, order_ids, since="", until=None):
    """Line items for a set of OrderIds: SPM_MfgOrderItem (→ ManufacturingOrderItem).
    Inward_JewelId = the produced piece once made."""
    return _extract_child_rows(
        cursor,
        "SPM_MfgOrderItem",
        "OrderId",
        order_ids,
        since,
        until,
    )


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


def extract_bags(cursor, since="", until=None):
    """Shop-floor bags = SPM_BagMaster (→ Eclat ProductionBag).

    Joined to SPM_DepartmentMst so Eclat stores a department NAME ("Polishing")
    rather than an opaque id, and stamped with the mapped Eclat stage so the
    backend can advance each order to the furthest point its bags have reached.
    """
    if not table_columns(cursor, "SPM_BagMaster"):
        log.info("  SPM_BagMaster not present — no manufacturing timeline on this install")
        return []
    department_columns = table_columns(cursor, "SPM_DepartmentMst")
    department_key = (
        department_columns.get("departmentid") or department_columns.get("id")
    )
    dependencies = (
        (("SPM_DepartmentMst", department_key, "DepartmentId"),)
        if department_key
        else ()
    )
    bags = _dependency_aware_base(
        cursor,
        "SPM_BagMaster",
        "BagId",
        since,
        until,
        dependencies,
    )

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
            raise

    for b in bags:
        did = b.get("DepartmentId")
        if did is not None and str(did) in names:
            b["DepartmentName"] = names[str(did)]
        stage = _stage_for("departmentToStage", did)
        if stage:
            b["EclatStage"] = stage
    return bags


def extract_payments(cursor, since="", until=None):
    """Day-book ledger movements = Journal (→ Eclat Payment / LedgerEntry). Double
    entry: DrAccountNo / CrAccountNo are PartyMst ledger accounts. Append-heavy, no
    UpdateDate — watermark on EntryDate / identity Id. ~475 rows.
    NOTE: cash/bank receipts with a payment MODE live in VoucherEntry (only 13 rows in
    the restored copy). Journal is the authoritative day-book here, so we sync it as the
    payment/ledger source; add a VoucherEntry extractor if the live DB uses receipts.
    # LIVE-DB: confirm whether the client books receipts in VoucherEntry vs Journal."""
    return _dependency_aware_base(
        cursor,
        "Journal",
        "Id",
        since,
        until,
        (("BookMaster", "BookNo", "BookNo"),),
    )


# ── Production sink: per-entity bulk-upsert to the Eclat REST API ──────────────
def _json_default(o):
    """JSON-serialise pyodbc values: datetime/date -> ISO, Decimal -> float, else str."""
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    return str(o)


# ── Run modes, set from the command line in __main__ ──────────────────────────
# Module-level rather than threaded through every call: sync_once() is the only
# consumer and the alternative is passing four flags through six layers.
DRY_RUN = False
LIMIT = 0
ONLY = []
# Controlled-sync flags (Phase 12): sync ONE store / ONE entity / a few rows before
# any full run. All three force `partial` -> the real watermark is NEVER advanced.
SAMPLE = False   # bounded trial run: small default LIMIT + per-batch breakdown
STORE = ""       # only rows resolving to this branch legacyId
ENTITY = ""      # restrict to one extractor (normalised into ONLY below)


def _attr_counts(records):
    """How the rows in a batch got their branch: a direct location column, the
    BookMaster fall-back (EclatBranchId present but no direct column), or nothing.
    Derived after stamp_branch() without changing it — used only for --sample."""
    direct = book = none = 0
    for r in records:
        if any(str(r.get(c) or "").strip() for c in ("LocationId", "BranchNo")):
            direct += 1
        elif str(r.get("EclatBranchId") or "").strip():
            book += 1
        else:
            none += 1
    return direct, book, none

# The unique key each entity is upserted on in Eclat. Used by validation to spot
# duplicates BEFORE they silently overwrite each other on the backend.
# Mirrors SyncService.DEFAULT_BRANCH_COLUMNS in the backend. Kept in sync by hand;
# if they drift, this preflight reports a different picture from what actually
# lands, which is worse than not reporting at all.
BRANCH_CANDIDATES = {
    "parties":  ["EclatBranchId", "BranchNo", "LocationId"],
    # products deliberately absent: the design catalogue is company-wide, so
    # "no branch" is the correct state and must not be reported as a problem.
    # CompanyId excluded on purpose — see the note on DEFAULT_BRANCH_COLUMNS in
    # the backend. Its values are legal entities and suppliers, not shops, so
    # including it gives 100% "coverage" that is mostly wrong.
    "stock":    ["EclatBranchId", "BranchNo", "LocationId", "FirstLocationId"],
    "sales":    ["EclatBranchId", "BranchNo", "LocationId"],
    "orders":   ["EclatBranchId", "BranchNo", "LocationId"],
}

LEGACY_KEYS = {
    "parties":     "PartyNo",
    "products":    "StyleId",
    "stock":       "JewelId",
    "sales":       "JewelTransId",
    "orders":      "OrderId",
    "order-items": "OrderItemId",
    "bags":        "BagId",
}


def validate_batches(batches):
    """Pre-upload sanity check. Returns a list of human-readable problems.

    This is deliberately advisory, not blocking: on a real install there is
    always some messy historical data, and refusing to sync because 12 pieces of
    2019 stock have no SKU would help nobody. The value is in SEEING it — a
    number that looks wrong here is a mapping bug caught before it reaches the
    dashboard, and a number that looks reasonable is permission to continue.
    """
    problems = []
    for entity, recs in batches:
        if not recs:
            continue

        # Duplicate legacy ids are the serious one: two rows with the same key
        # means the second silently overwrites the first, so the client's totals
        # come out short and nothing errors.
        key = LEGACY_KEYS.get(entity)
        if key:
            seen, dupes = set(), set()
            missing_key = 0
            for r in recs:
                v = r.get(key)
                if v is None or str(v).strip() == "":
                    missing_key += 1
                    continue
                v = str(v).strip()
                if v in seen:
                    dupes.add(v)
                seen.add(v)
            if dupes:
                sample = ", ".join(sorted(dupes)[:5])
                problems.append(f"{entity}: {len(dupes)} DUPLICATE {key} value(s) "
                                f"— later rows overwrite earlier ones (e.g. {sample})")
            if missing_key:
                problems.append(f"{entity}: {missing_key} row(s) have no {key} "
                                f"— these will be skipped by the backend")

        # Entity-specific checks worth a human's attention.
        if entity == "stock":
            no_sku = sum(1 for r in recs
                         if not str(r.get("InwardSKUNo") or "").strip()
                         and not str(r.get("JewelCode") or "").strip())
            if no_sku:
                problems.append(f"stock: {no_sku} piece(s) have no SKU or code "
                                f"— they will show as unnamed in the catalogue")
        cands = BRANCH_CANDIDATES.get(entity)
        if cands:
            no_branch = sum(
                1 for r in recs
                if not any(str(r.get(c) or "").strip() for c in cands)
            )
            if no_branch:
                pct = no_branch * 100 // len(recs)
                problems.append(
                    f"{entity}: {no_branch} of {len(recs)} row(s) ({pct}%) name no branch "
                    f"— they land in the 'Unassigned' store, not a real shop")
    return problems


def _parse_zero_skip_ack(response, expected_rows, expected_entity):
    """Return the server watermark only for a complete, consistent batch ack.

    A HTTP 2xx is transport success, not proof that the whole batch was accepted.
    Advancing a source watermark after a partial or malformed response would make
    rejected source rows disappear from later runs, so this contract is strict.
    """
    try:
        body = response.json()
    except Exception as exc:
        raise ValueError("HTTP 2xx body is not valid JSON") from exc
    if not isinstance(body, dict):
        raise ValueError("HTTP 2xx body must be a JSON object")

    if body.get("entity") != expected_entity:
        raise ValueError(
            f"entity mismatch (expected {expected_entity!r}, got {body.get('entity')!r})"
        )

    counts = {}
    for name in ("received", "upserted", "skipped"):
        value = body.get(name)
        # bool is an int subclass in Python, but is never a valid row count.
        if type(value) is not int or value < 0:
            raise ValueError(f"{name} must be a non-negative integer")
        counts[name] = value

    if counts["received"] != expected_rows:
        raise ValueError(
            f"received={counts['received']} does not match sent={expected_rows}"
        )
    if counts["upserted"] + counts["skipped"] != counts["received"]:
        raise ValueError("upserted + skipped does not equal received")
    if counts["skipped"] != 0:
        raise ValueError(f"server skipped {counts['skipped']} row(s)")
    if counts["upserted"] != expected_rows:
        raise ValueError(
            f"upserted={counts['upserted']} does not match sent={expected_rows}"
        )

    if "watermark" not in body:
        raise ValueError("watermark field is missing")
    watermark = body["watermark"]
    if watermark is not None and (
        not isinstance(watermark, str) or not watermark.strip()
    ):
        raise ValueError("watermark must be null or a non-empty string")
    return body, watermark


def push_chunked(token, base_url, entity, records, label="sync"):
    """POST records to POST /sync/<entity> in 3000-row chunks (the backend upserts
    on legacyId). Returns (ok, watermark): `ok` is True only if EVERY chunk got a
    complete zero-skip acknowledgement whose counts cover every sent row. A
    malformed, inconsistent or partial HTTP 2xx is a failure too, so the source
    watermark stays put and every row retries next run. `watermark` is the max
    legacy UpdateDate/EntryDate the backend acknowledged."""
    if not records:
        log.info(f"  {label}: no {entity} data")
        return True, None
    chunk_size, total = 3000, len(records)
    chunks = (total + chunk_size - 1) // chunk_size
    url = f"{base_url}/sync/{entity}"
    all_ok, watermark = True, None
    for i in range(0, total, chunk_size):
        chunk = records[i:i + chunk_size]
        part = (i // chunk_size) + 1
        tag = f"{entity} ({part}/{chunks})" if chunks > 1 else entity
        try:
            heartbeat(
                base_url,
                "uploading",
                entity=entity,
                rowsRead=i,
                rowsReady=total,
            )
            hdrs = sync_headers(base_url)
            payload = json.dumps({"records": chunk}, default=_json_default)
            log.info(f"  Pushing {tag}: {len(chunk)} rows...")
            r = requests.post(
                url, headers=hdrs, data=payload, timeout=180, allow_redirects=False
            )
            if 200 <= r.status_code < 300:
                try:
                    resp, wm = _parse_zero_skip_ack(r, len(chunk), entity)
                    if wm and (watermark is None or wm > watermark):
                        watermark = wm
                    log.info(f"  {tag}: upserted={resp.get('upserted')} skipped={resp.get('skipped')}")
                except ValueError as e:
                    log.error(f"  {tag}: REJECTED acknowledgement: {e}")
                    all_ok = False
            else:
                log.error(f"  {tag}: FAILED {r.status_code}: {r.text[:200]}")
                all_ok = False
        except Exception as e:
            log.error(f"  {tag}: error: {e}")
            all_ok = False
    # Never leak an earlier chunk's watermark after a later chunk failed. This
    # prevents a caller regression from persisting a partially accepted batch.
    return all_ok, watermark if all_ok else None


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
    is never missed. Failures are accumulated while later entities still run.
    """
    cols = table_columns(cursor, "PartyMst")
    if not cols:
        log.warning(f"  [{base_url}] stores: PartyMst not found — skipping")
        return True

    # LIVE-DB: BRANCH-DETECTION PREDICATE — CONFIRM BEFORE FIRST RUN.
    # The schema notes model a store/branch as a PartyMst row with a location flag
    # (role bits IsLocation / IsFactory). Confirm on the CLIENT'S LIVE install which
    # flag actually marks a sellable branch vs an internal factory/godown — some
    # APRS-SJEP versions set only IsLocation, some also set IsFactory, and the flag
    # column names can differ by version. Best-effort: match whichever of these
    # flags exists; if NEITHER exists we bail rather than mass-import every party as
    # a store. (Also consider excluding cancelled/inactive rows if the live schema
    # carries an IsActive/IsBlackList flag on locations.)
    # WHICH PARTIES ARE ACTUALLY BRANCHES?
    #
    # NOT the ones flagged IsLocation/IsFactory. Measured on the client's live
    # database, that flag returns supplier firms, two holding companies and a
    # test row called "abc" — while the party ids the STOCK actually points at
    # (Inward.BranchNo) are a completely different set, and the overlap between
    # the two was exactly zero. Trusting the flag created nine stores that no
    # record referenced, so every piece of stock would have landed in
    # "Unassigned" and each shop would have opened Eclat to an empty inventory.
    #
    # So the definition is inverted: a branch is a party that something is
    # RECORDED AGAINST — ids referenced as a BranchNo anywhere in the data.
    #
    # The flags are a FALLBACK ONLY, used when nothing is referenced at all (a
    # brand-new install with no transactions yet, or a schema where the branch
    # column is named something we do not check). They are deliberately NOT
    # unioned in when referenced ids exist: doing exactly that re-created all
    # nine junk stores on the run of 2026-07-31 — 19 rows sent where 10 were
    # real — because "add the flag rows on top, harmless when the flag is used
    # properly" assumes a property this install does not have. On a database
    # where the flag is wrong, the union is wrong, and the referenced ids are
    # already the complete and correct answer.
    referenced = set()
    all_ok = True
    for table, col in (("Inward", "BranchNo"), ("PartyMst", "BranchNo"),
                       ("BookMaster", "BranchNo"), ("Inward", "LocationId"),
                       ("JewelTrans", "BranchNo")):
        tcols = table_columns(cursor, table)
        if not tcols or col.lower() not in tcols:
            continue
        try:
            cursor.execute(
                f"SELECT DISTINCT [{tcols[col.lower()]}] AS v FROM [{table}] "
                f"WHERE [{tcols[col.lower()]}] IS NOT NULL")
            for r in rows(cursor):
                v = str(r.get("v") or "").strip()
                if v:
                    referenced.add(v)
        except Exception as e:
            log.warning(f"  branch ids from {table}.{col}: {e}")
            all_ok = False

    flag_preds = []
    if "islocation" in cols:
        flag_preds.append("t.IsLocation = 1")
    if "isfactory" in cols:
        flag_preds.append("t.IsFactory = 1")

    if not referenced and not flag_preds:
        log.warning(f"  [{base_url}] stores: nothing identifies a branch on this "
                    f"install — skipping (# LIVE-DB: confirm branch column)")
        return all_ok
    log.info(f"  {len(referenced)} party id(s) are referenced as a branch by the data")

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
        return all_ok

    sel = [f"t.{pk_col} AS legacyId", f"t.{name_col} AS name"]
    if city_col:
        sel.append(f"t.{city_col} AS city")
    if code_col:
        sel.append(f"t.{code_col} AS code")

    # OFFICE ADDRESS + CONTACT. Each is selected only if the column exists on this
    # install, so a version missing (say) FirmState never errors the whole pull.
    # These land on the Eclat Store row and are what the app prints on documents
    # and shows on the store profile.
    detail_map = {
        "firmadd1":    "addressLine1",
        "firmadd2":    "addressLine2",
        "firmstate":   "state",
        "pincode":     "pincode",
        "firmcountry": "country",
        "firmtele":    "phone",
        "firmemail":   "email",
        "accgst":      "gstin",
    }
    present_details = {}
    for src, dest in detail_map.items():
        col = cols.get(src)
        if col:
            sel.append(f"t.{col} AS {dest}")
            present_details[dest] = True
    # FirmAdd3 folds into line 2 when both exist — Eclat holds two address lines
    # and dropping the third silently would lose part of the address.
    add3_col = cols.get("firmadd3")
    if add3_col:
        sel.append(f"t.{add3_col} AS addressLine3")
    # A mobile is more use than a landline for a branch; taken only if FirmTele
    # is absent, so we never overwrite the office number with someone's mobile.
    mobile_col = cols.get("ownermobile") or cols.get("whatsappno")
    if mobile_col and "phone" not in present_details:
        sel.append(f"t.{mobile_col} AS phone")

    # Referenced ids win outright. The flags are consulted only when the data
    # names no branch at all — see the note above; unioning the two is what put
    # "APRS HO" and "abc" in the store picker.
    params = []
    if referenced:
        ph = ",".join("?" for _ in referenced)
        where = f"t.{pk_col} IN ({ph})"
        params = sorted(referenced)
        if flag_preds:
            log.info(f"  ignoring {len(flag_preds)} location flag(s) — the data "
                     f"already names its branches")
    else:
        where = " OR ".join(flag_preds)
        log.warning("  no branch is referenced by any record — falling back to the "
                    "IsLocation/IsFactory flags. CHECK THE RESULT: on some installs "
                    "those flags return suppliers and holding companies, not shops.")
    # Best-effort query (READ-ONLY). Marked columns/predicate above pending confirmation.
    cursor.execute(f"SELECT {', '.join(sel)} FROM PartyMst t WHERE {where}", *params)
    raw = rows(cursor)

    # Map each location row to the /sync/stores contract.
    text_fields = ["city", "code", "addressLine1", "addressLine2", "state",
                   "pincode", "country", "phone", "email", "gstin"]
    records = []
    for r in raw:
        lid = r.get("legacyId")
        if lid is None or str(lid).strip() == "":
            continue
        rec = {"legacyId": str(lid).strip(), "name": str(r.get("name") or "").strip()}
        for f in text_fields:
            v = r.get(f)
            if v is not None and str(v).strip():
                rec[f] = str(v).strip()
        add3 = r.get("addressLine3")
        if add3 is not None and str(add3).strip():
            extra = str(add3).strip()
            rec["addressLine2"] = f"{rec['addressLine2']}, {extra}" if rec.get("addressLine2") else extra
        records.append(rec)

    if not records:
        log.info(f"  [{base_url}] stores: no branch/location rows matched")
        return all_ok

    url  = f"{base_url}/sync/stores"
    try:
        heartbeat(base_url, "uploading", entity="stores", rowsReady=len(records))
        hdrs = sync_headers(base_url)
        payload = json.dumps({"records": records}, default=_json_default)
        log.info(f"  [{base_url}] pushing stores: {len(records)} branch/location rows...")
        r = requests.post(
            url, headers=hdrs, data=payload, timeout=120, allow_redirects=False
        )
        if 200 <= r.status_code < 300:
            try:
                resp = r.json()
                if not isinstance(resp, dict):
                    raise ValueError("non-object acknowledgement")
                created = resp.get("created")
                updated = resp.get("updated")
                if not isinstance(created, list) or not isinstance(updated, list):
                    raise ValueError("missing created/updated receipt arrays")
                if len(created) + len(updated) != len(records):
                    raise ValueError("receipt counts do not cover every sent store")
                log.info(
                    f"  [{base_url}] stores: created={len(created)} "
                    f"updated={len(updated)} (sent {len(records)})"
                )
            except Exception as exc:
                log.error(f"  [{base_url}] stores: REJECTED acknowledgement: {exc}")
                all_ok = False
        else:
            log.error(f"  [{base_url}] stores: FAILED {r.status_code}: {r.text[:200]}")
            all_ok = False
    except Exception as e:
        log.error(f"  [{base_url}] stores: error: {e}")
        all_ok = False
    return all_ok


def push_staff(cursor, token, base_url):
    """Push the client's PEOPLE to POST /sync/staff.

    Source is `PartyMst` rows flagged `IsSalesMan` — in this schema a salesperson
    is a party, not a separate employee table (the legacy HR tables exist but are
    empty, see docs/legacy-schema.md module 6). Where an `SPM_Users` login table
    exists we also read designation/role text from it for the activation review.

    Imported people arrive in Eclat **inactive and unable to sign in** until head
    office activates them. That is a backend guarantee, not a convention here.

    Like the store catalog this runs a full pull every cycle (the roster is tiny
    and must be complete); failures are included in the run-level exit status.
    """
    cols = table_columns(cursor, "PartyMst")
    if not cols:
        log.warning(f"  [{base_url}] staff: PartyMst not found — skipping")
        return True
    if "issalesman" not in cols:
        log.warning(f"  [{base_url}] staff: no IsSalesMan flag on PartyMst — skipping "
                    f"(# LIVE-DB: confirm how staff are marked on this install)")
        return True

    pk_col   = cols.get("partyno")
    name_col = cols.get("firmname") or cols.get("legalname")
    if not pk_col or not name_col:
        log.warning(f"  [{base_url}] staff: PartyMst missing PartyNo/FirmName — skipping")
        return True

    sel = [f"t.{pk_col} AS legacyId", f"t.{name_col} AS name"]
    for src, dest in [("firmemail", "email"), ("ownermobile", "phone"),
                      ("updatedate", "updatedAt")]:
        col = cols.get(src)
        if col:
            sel.append(f"t.{col} AS {dest}")
    if "phone" not in [s.split(" AS ")[-1] for s in sel]:
        alt = cols.get("whatsappno") or cols.get("firmtele")
        if alt:
            sel.append(f"t.{alt} AS phone")
    # Which branch the person belongs to, so Eclat can pre-assign their store.
    branch_col = cols.get("branchno") or cols.get("locationid")
    if branch_col:
        sel.append(f"t.{branch_col} AS storeLegacyId")

    cursor.execute(f"SELECT {', '.join(sel)} FROM PartyMst t WHERE t.IsSalesMan = 1")
    raw = rows(cursor)

    records = []
    for r in raw:
        lid = r.get("legacyId")
        name = str(r.get("name") or "").strip()
        if lid is None or str(lid).strip() == "" or not name:
            continue
        rec = {"legacyId": str(lid).strip(), "name": name}
        for f in ("email", "phone", "storeLegacyId"):
            v = r.get(f)
            if v is not None and str(v).strip():
                rec[f] = str(v).strip()
        upd = r.get("updatedAt")
        if upd is not None:
            rec["updatedAt"] = _json_default(upd) if not isinstance(upd, str) else upd
        records.append(rec)

    if not records:
        log.info(f"  [{base_url}] staff: no salesperson rows matched")
        return True

    url  = f"{base_url}/sync/staff"
    ok = True
    try:
        heartbeat(base_url, "uploading", entity="staff", rowsReady=len(records))
        hdrs = sync_headers(base_url)
        payload = json.dumps({"records": records}, default=_json_default)
        log.info(f"  [{base_url}] pushing staff: {len(records)} people...")
        r = requests.post(
            url, headers=hdrs, data=payload, timeout=120, allow_redirects=False
        )
        if 200 <= r.status_code < 300:
            try:
                resp = r.json()
                if not isinstance(resp, dict):
                    raise ValueError("non-object acknowledgement")
                counts = tuple(
                    resp.get(name)
                    for name in ("received", "created", "updated", "skipped")
                )
                if any(type(value) is not int or value < 0 for value in counts):
                    raise ValueError("invalid acknowledgement counts")
                if counts[0] != len(records) or sum(counts[1:]) != counts[0]:
                    raise ValueError("receipt counts do not cover every sent staff row")
            except Exception as exc:
                log.error(f"  [{base_url}] staff: REJECTED acknowledgement: {exc}")
                return False
            log.info(f"  [{base_url}] staff: created={resp.get('created','?')} "
                     f"updated={resp.get('updated','?')} skipped={resp.get('skipped','?')}")
            pending = resp.get("pendingActivation")
            if pending:
                log.info(f"  [{base_url}] staff: {pending} awaiting activation in Eclat "
                         f"(they cannot sign in until head office activates them)")
            for c in (resp.get("conflicts") or [])[:10]:
                log.warning(f"  [{base_url}] staff conflict: {c}")
        else:
            log.error(f"  [{base_url}] staff: FAILED {r.status_code}: {r.text[:200]}")
            ok = False
    except Exception as e:
        log.error(f"  [{base_url}] staff: error: {e}")
        ok = False
    return ok


def run_test():
    """Verify restricted agent approval + SQL Server connect BEFORE scheduling."""
    log.info("=" * 50); log.info("CONNECTION TEST"); ok = True
    log.info(f"Targets: {', '.join(BACKENDS)}")
    for base_url in BACKENDS:
        if login(base_url): log.info(f"[OK]  Gati agent approval: {base_url}")
        else: log.error(f"[FAIL] Gati agent approval: {base_url} — check token and approved hashes"); ok = False
    conn = connect_sql()
    if conn:
        log.info("[OK]  SQL Server connected"); conn.close()
    else:
        log.error("[FAIL] SQL Server — check driver / server / credentials / read-only login"); ok = False
    if not ok:
        for base_url in BACKENDS:
            terminal_heartbeat(base_url, False, "Gati connection test failed")
    log.info("RESULT: " + ("TEST PASSED" if ok else "TEST FAILED")); log.info("=" * 50)
    return ok


# ── Generic FULL MIRROR: dump EVERY table to /sync/raw (extract-everything-once) ──
# So that ANY field/table the client ever needs is already in Eclat, with no code
# change. Each table is incremental (UpdateDate/EntryDate) and self-healing: a table
# that errors is skipped so later tables still run, but makes the process exit 1.
def list_tables(cursor):
    """Every base table in the DB (skips views + system tables)."""
    cursor.execute(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
        "WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
    )
    return [r[0] for r in cursor.fetchall()]


def pk_columns(cursor, table):
    """Primary-key column names for `table`, in order — used for a stable row key."""
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


def _row_key(row, pks):
    """Stable per-row key: the PK values joined, else an MD5 of the whole row."""
    if pks:
        return "|".join(str(row.get(c)) for c in pks)
    blob = json.dumps(row, default=_json_default, sort_keys=True)
    return hashlib.md5(blob.encode("utf-8")).hexdigest()


def push_raw(token, base_url, table, records, chunk_size=1500):
    """POST raw rows to POST /sync/raw in chunks (SELECT * rows are wide, so a
    smaller chunk keeps payloads under the body limit). Like mapped ingestion, a
    table advances only after complete, consistent, zero-skip acknowledgements."""
    if not records:
        return True, None
    url = f"{base_url}/sync/raw"
    all_ok, watermark = True, None
    for i in range(0, len(records), chunk_size):
        chunk = records[i:i + chunk_size]
        try:
            heartbeat(
                base_url,
                "uploading",
                entity="raw",
                rowsRead=i,
                rowsReady=len(records),
            )
            hdrs = sync_headers(base_url)
            payload = json.dumps({"table": table, "records": chunk}, default=_json_default)
            r = requests.post(
                url, headers=hdrs, data=payload, timeout=300, allow_redirects=False
            )
            if 200 <= r.status_code < 300:
                try:
                    _, wm = _parse_zero_skip_ack(r, len(chunk), f"raw:{table}")
                    if wm and (watermark is None or wm > watermark):
                        watermark = wm
                except ValueError as e:
                    log.error(f"    raw {table}: REJECTED acknowledgement: {e}")
                    all_ok = False
            else:
                log.error(f"    raw {table}: FAILED {r.status_code}: {r.text[:150]}")
                all_ok = False
        except Exception as e:
            log.error(f"    raw {table}: error: {e}")
            all_ok = False
    return all_ok, watermark if all_ok else None


def dump_all(cursor, token, base_url, state, extraction_until=None):
    """Mirror EVERY table to LegacyRow via /sync/raw — the extract-everything-once
    sink. Incremental per-table (state key 'raw::<base>::<table>'). Errors per table
    are logged and skipped so one bad table never blocks the rest, while the final
    run result remains failed and its table checkpoint remains unchanged."""
    tables = list_tables(cursor)
    log.info(f"  [{base_url}] full mirror: scanning {len(tables)} tables")
    scanned = pushed = 0
    all_ok = True
    for tbl in tables:
        heartbeat(
            base_url,
            "extracting",
            entity="raw",
            entitiesChecked=scanned,
        )
        skey = raw_state_key(base_url, tbl)
        since = state.get(skey, "")
        try:
            wm_clause, params = _wm(cursor, tbl, since, extraction_until)
            cursor.execute(f"SELECT * FROM [{tbl}] t WHERE {wm_clause}", *params)
            recs = rows(cursor)
        except Exception as e:
            log.warning(f"    raw {tbl}: skip ({str(e)[:90]})")
            all_ok = False
            continue
        scanned += 1
        if not recs:
            continue
        try:
            pks = pk_columns(cursor, tbl)
        except Exception as e:
            log.warning(f"    raw {tbl}: primary-key read failed ({str(e)[:90]})")
            all_ok = False
            continue
        for r in recs:
            r["_rowKey"] = _row_key(r, pks)
            r["_updatedAt"] = r.get("UpdateDate") or r.get("EntryDate")
        ok, wm = push_raw(token, base_url, tbl, recs)
        if ok:
            pushed += 1
            if wm and (not since or wm > since):
                prior_present = skey in state
                prior_value = state.get(skey)
                state[skey] = wm
                _remember_checkpoint_context(state, base_url)
                if not save_state(state):
                    all_ok = False
                    if prior_present:
                        state[skey] = prior_value
                    else:
                        state.pop(skey, None)
        else:
            all_ok = False
    log.info(f"  [{base_url}] full mirror done: scanned={scanned}, {pushed} tables had new rows")
    return all_ok


def sync_once():
    log.info("=" * 50)
    log.info(f"Sync started at {datetime.now():%Y-%m-%d %H:%M:%S}")
    log.info(f"Targets: {', '.join(BACKENDS)}")
    APPROVAL_HEADERS.clear()
    HEARTBEATS.clear()
    CHECKPOINT_CONTEXTS.clear()
    run_ok = True

    # Authenticate before opening SQL so a database/extraction failure can be
    # reported to head office instead of leaving the agent looking healthy.
    if not DRY_RUN:
        for base_url in BACKENDS:
            if not login(base_url):
                run_ok = False
        if not run_ok:
            return False

    try:
        state = load_state()
    except Exception as exc:
        run_ok = False
        log.error(f"Cannot load sync checkpoints: {exc}")
        for base_url in BACKENDS:
            terminal_heartbeat(base_url, False, exc)
        return False

    conn = connect_sql()
    if not conn:
        for base_url in BACKENDS:
            terminal_heartbeat(base_url, False, "SQL Server connection failed")
        return False
    if DRY_RUN:
        approval = approval_summary(SQL_SERVER, SQL_DB)
        log.info(f"Gati approval profileId: {approval['profileId']}")
        log.info(f"Gati approval profileHash: {approval['profileHash']}")
        log.info(f"Gati approval sourceInstanceHash: {approval['sourceInstanceHash']}")
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT GETDATE()")
        extraction_until = cursor.fetchone()[0]
        log.info(f"SQL extraction upper bound: {extraction_until}")
        # Push the SAME read-only data to EVERY configured backend (local + prod).
        # Each target keeps its OWN watermark, so one being down never blocks another.
        for base_url in BACKENDS:
            base_ok = True
            # A dry run inspects the CLIENT's data and uploads nothing, so it must
            # work before the Eclat credentials are settled — that is precisely
            # when you want to run it. Log in if we can, carry on if we cannot.
            token = None if DRY_RUN else AGENT_TOKEN
            if not token:
                if DRY_RUN:
                    log.warning(f"  [{base_url}] could not log in — continuing anyway "
                                f"(dry run uploads nothing)")
                else:
                    log.error(f"  [{base_url}] login failed — skipping (retries next run)")
                    continue
            # Preview mode intentionally works before a machine credential or
            # approval exists.  It uploads and checkpoints nothing, so a full
            # bounded read is both safe and the only meaningful preview.
            watermarks = (
                {source: "" for source in MAPPED_SOURCES}
                if DRY_RUN
                else mapped_watermarks(state, base_url)
            )
            if state.get(base_url):
                log.warning(
                    f"  [{base_url}] ignoring legacy shared watermark; each source "
                    "will be reread once and checkpointed independently"
                )
            log.info(
                f"  [{base_url}] mapped checkpoints: "
                + ", ".join(
                    f"{name}={value or '(full backfill)'}"
                    for name, value in watermarks.items()
                )
            )

            # Controlled mode (--sample/--store/--entity) targets ONE extractor's
            # rows; the store-catalog and staff pushes are a separate, full-catalog
            # concern, so skip them here to keep a trial run to exactly what was
            # asked for. They still run on a normal (uncontrolled) sync.
            controlled = bool(SAMPLE or STORE or ENTITY)

            # STORE CATALOG FIRST — a new branch created in the client's Gati must
            # exist in Eclat BEFORE the parties/stock/sales that reference it sync.
            # A store-push failure logs and later entities still run, but the final
            # process status is nonzero. No watermark — full idempotent
            # upsert every run.
            # NEXT STEP (not this change): per-row location -> store stamping. Today
            # transaction rows still ride the single backend defaultStoreId; once the
            # branch-detection predicate above is confirmed against the live schema,
            # stamp each party/stock/sale row with its LocationId -> Eclat storeId.
            try:
                if not DRY_RUN and not controlled:
                    base_ok = push_stores(cursor, token, base_url) and base_ok
                elif controlled:
                    log.info(f"  [{base_url}] stores push skipped (controlled run)")
            except Exception as e:
                log.error(f"  [{base_url}] stores push error: {e}")
                base_ok = False

            # Staff AFTER stores: a person carries their branch legacyId, and the
            # backend can only pre-assign them to a store that already exists.
            #
            # SKIPPABLE — and it SHOULD be skipped once the shop has gone live on
            # the self-signup + approval flow. There, people register themselves
            # and a manager / head office approves them; re-importing Gati's staff
            # every 15 minutes would fight that model and re-populate the roster
            # after the go-live account wipe. Keep it ON for the initial backfill,
            # turn it OFF (in eclat_config.bat) the moment you switch to self-signup.
            #
            #   sync_sjep.py --no-staff      one run
            #   set SJEP_SKIP_STAFF=1        every run  (recommended post-go-live)
            skip_staff = (controlled
                          or "--no-staff" in sys.argv
                          or os.getenv("SJEP_SKIP_STAFF", "").strip().lower()
                          in ("1", "true", "yes"))
            try:
                if skip_staff:
                    log.info(f"  [{base_url}] staff import skipped (--no-staff): staff "
                             f"self-register and are approved in-app.")
                elif not DRY_RUN:
                    base_ok = push_staff(cursor, token, base_url) and base_ok
            except Exception as e:
                log.error(f"  [{base_url}] staff push error: {e}")
                base_ok = False

            extraction_ok = {}

            def extract_or_empty(label, operation, fallback=None):
                nonlocal run_ok
                try:
                    heartbeat(base_url, "extracting", entity=label)
                    result = operation()
                    extraction_ok[label] = True
                    return result
                except Exception as exc:
                    log.error(f"  [{base_url}] {label} extraction failed: {exc}")
                    run_ok = False
                    extraction_ok[label] = False
                    return [] if fallback is None else fallback

            parties = extract_or_empty(
                "parties",
                lambda: extract_parties(
                    cursor, watermarks["parties"], extraction_until
                ),
            )
            items = extract_or_empty(
                "products",
                lambda: extract_items(
                    cursor, watermarks["products"], extraction_until
                ),
            )
            stock = extract_or_empty(
                "stock",
                lambda: extract_stock(cursor, watermarks["stock"], extraction_until),
            )
            sales = extract_or_empty(
                "sales",
                lambda: extract_sales(cursor, watermarks["sales"], extraction_until),
            )
            lines = extract_or_empty(
                "sale-lines",
                lambda: extract_sale_lines(
                    cursor,
                    [s["JewelTransId"] for s in sales],
                    watermarks["sale-lines"],
                    extraction_until,
                ),
            )
            orders = extract_or_empty(
                "orders",
                lambda: decorate_orders_with_stage(
                    extract_orders(
                        cursor, watermarks["orders"], extraction_until
                    )
                ),
            )
            oitems = extract_or_empty(
                "order-items",
                lambda: extract_order_items(
                    cursor,
                    [o["OrderId"] for o in orders],
                    watermarks["order-items"],
                    extraction_until,
                ),
            )
            bags = extract_or_empty(
                "bags",
                lambda: extract_bags(cursor, watermarks["bags"], extraction_until),
            )
            payments = extract_or_empty(
                "ledger",
                lambda: extract_payments(
                    cursor, watermarks["ledger"], extraction_until
                ),
            )
            moves = extract_or_empty(
                "stock-movements",
                lambda: extract_stock_movements(
                    cursor, watermarks["stock-movements"], extraction_until
                ),
            )
            base_ok = base_ok and run_ok

            # Branch attribution. Stock and parties already carry a location
            # column (the extractors SELECT *), so the backend reads those
            # directly; sales and orders carry none and are tagged here via their
            # document book. Cheap — BookMaster is a few hundred rows.
            book_branch = extract_or_empty(
                "branch-map", lambda: build_book_branch_map(cursor), {}
            )
            if extraction_ok.get("branch-map") is False:
                # These sources rely on BookMaster for store attribution. Do not
                # upload or checkpoint them against an empty fallback map after
                # a SQL failure; the complete source groups retry next cycle.
                for dependent in (
                    "sales",
                    "sale-lines",
                    "orders",
                    "order-items",
                    "ledger",
                ):
                    extraction_ok[dependent] = False
            stamp_branch(sales, book_branch, "sales")
            stamp_branch(orders, book_branch, "orders")
            # Journal has no location column either — same document-book route.
            stamp_branch(payments, book_branch, "ledger")

            # --store: keep only the rows that resolve to ONE branch. Stamp every
            # store-scoped entity first (parties/stock carry LocationId/BranchNo
            # directly; sales/orders/ledger were stamped via the book above) then
            # filter on EclatBranchId. Products stay untouched — the design
            # catalogue is company-global, not per-store. The line/order-item
            # children have no branch of their own, so they simply follow whichever
            # of their parents survived (pure in-memory trim, no re-query).
            if STORE:
                want = str(STORE).strip()
                log.info(f"  [{base_url}] --store {want}: filtering to one branch")

                def _keep(recs, label):
                    stamp_branch(recs, book_branch)
                    kept = [r for r in recs
                            if str(r.get("EclatBranchId") or "").strip() == want]
                    log.info(f"    {label}: kept {len(kept)} / {len(recs)} "
                             f"(dropped {len(recs) - len(kept)} other-branch/unattributed)")
                    return kept

                parties  = _keep(parties, "parties")
                stock    = _keep(stock, "stock")
                sales    = _keep(sales, "sales")
                orders   = _keep(orders, "orders")
                bags     = _keep(bags, "bags")
                payments = _keep(payments, "ledger")
                moves    = _keep(moves, "stock-movements")
                sids = {s.get("JewelTransId") for s in sales}
                lines = [l for l in lines if l.get("JewelTransId") in sids]
                oids = {o.get("OrderId") for o in orders}
                oitems = [it for it in oitems if it.get("OrderId") in oids]

            log.info(f"  [{base_url}] extracted: parties={len(parties)} items={len(items)} "
                     f"stock={len(stock)} sales={len(sales)}({len(lines)} lines) "
                     f"orders={len(orders)}({len(oitems)} items) bags={len(bags)} "
                     f"ledger={len(payments)} movements={len(moves)}")

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
                # Day book and per-piece history. Both were extracted from the
                # first version and never sent: there was no endpoint to send
                # them to, so 1,134 ledger rows and 14,374 movements were read
                # and discarded on every run, and Finance stayed empty.
                ("ledger", payments),
                # After stock: a movement is skipped if its piece is not there.
                ("stock-movements", moves),
            ]

            # PHASE FILTER — bring data across in stages rather than all at once.
            # A mapping mistake found on 500 customers is a conversation; the same
            # mistake found after every table has shipped is a cleanup job.
            if ONLY:
                wanted = set(ONLY)
                unknown = wanted - {e for e, _ in batches}
                if unknown:
                    log.warning(f"  --only: unknown entity name(s) ignored: {', '.join(sorted(unknown))}")
                batches = [(e, r) for e, r in batches if e in wanted]
                log.info(f"  --only: syncing {', '.join(e for e, _ in batches) or '(nothing)'}")

            # SMALL-BATCH FIRST — cap each entity so the first real run can be
            # eyeballed in the dashboard before thousands of rows land.
            if LIMIT:
                batches = [(e, r[:LIMIT]) for e, r in batches]
                log.info(f"  --limit {LIMIT}: sending at most {LIMIT} row(s) per entity")

            # PREFLIGHT — look for the mistakes that are cheap to spot now and
            # expensive to unpick later.
            problems = validate_batches(batches)

            if DRY_RUN:
                log.info("")
                log.info("  DRY RUN — nothing was uploaded.")
                for entity, recs in batches:
                    log.info(f"    {entity:<14} {len(recs):>7} row(s)")
                if problems:
                    log.warning("  Issues that would have been uploaded as-is:")
                    for p in problems:
                        log.warning(f"    - {p}")
                else:
                    log.info("  No data problems found.")
                log.info("")
                log.info("  Re-run without --dry-run to upload.")
                continue

            all_ok = True
            batch_ok = {}
            batch_watermarks = {}
            for entity, recs in batches:
                # --sample prints the per-batch attribution breakdown BEFORE the
                # upload; push_chunked already logs upserted/skipped and any errors
                # per chunk, so together that is the detailed per-batch result.
                if SAMPLE:
                    d, b, n = _attr_counts(recs)
                    log.info(f"  [sample] {entity}: {len(recs)} row(s) -> "
                             f"attributed(direct)={d} fell-back(book)={b} unknown/none={n}")
                if extraction_ok.get(entity) is False:
                    log.error(
                        f"  [{base_url}] {entity}: upload skipped because extraction failed"
                    )
                    ok, wm = False, None
                else:
                    ok, wm = push_chunked(token, base_url, entity, recs)
                batch_ok[entity] = ok
                batch_watermarks[entity] = wm
                all_ok = all_ok and ok
            base_ok = base_ok and all_ok and run_ok

            # A capped, filtered, sampled or single-store run has NOT seen all the
            # data, so advancing the watermark would permanently skip whatever was
            # left behind. The real watermark file is simply never written here.
            partial = bool(LIMIT or ONLY or SAMPLE or STORE)
            if partial:
                log.info("  Partial run (--sample/--store/--entity/--limit/--only): "
                         "watermark deliberately NOT advanced, so the full run still "
                         "picks everything up.")

            if partial:
                pass   # nothing to say; the line above already explained it
            else:
                state_before_mapped = dict(state)
                changed = advance_mapped_watermarks(
                    state, base_url, batch_ok, batch_watermarks
                )
                if changed:
                    if not save_state(state):
                        state.clear()
                        state.update(state_before_mapped)
                        base_ok = False
                    else:
                        log.info(
                            f"  [{base_url}] acknowledged mapped checkpoints saved"
                        )
                else:
                    log.info(
                        f"  [{base_url}] no acknowledged mapped checkpoint changed"
                    )
                if not all_ok:
                    log.error(
                        f"  [{base_url}] failed entity checkpoints were NOT advanced; "
                        "those source rows retry next cycle"
                    )

            # FULL RAW MIRROR — dump every table so ANY field is available later,
            # with no code change. Independent of the mapped sync above; its own
            # per-table watermarks mean it only ships changed rows after the first run.
            #
            # Skippable, because the first run of it is long and almost entirely
            # not about jewellery: on this client it scans 1,136 tables, the
            # largest being 72,830 rows of international port codes. The
            # shop-facing sync above has already finished and advanced its
            # watermark by this point, so stopping here costs nothing the shop
            # can see — which also means it is safe to Ctrl+C.
            #
            #   sync_sjep.py --no-mirror     one run
            #   set SJEP_SKIP_MIRROR=1       every run
            skip_mirror = ("--no-mirror" in sys.argv
                           or os.getenv("SJEP_SKIP_MIRROR", "").strip().lower()
                           in ("1", "true", "yes"))
            try:
                if skip_mirror:
                    log.info(f"  [{base_url}] full mirror skipped (--no-mirror). The "
                             f"shop data above is complete; the mirror is the "
                             f"keep-everything backup and can run any time.")
                elif not DRY_RUN and not ONLY and not LIMIT and not STORE and not SAMPLE:
                    base_ok = dump_all(
                        cursor, token, base_url, state, extraction_until
                    ) and base_ok
            except Exception as e:
                log.error(f"  [{base_url}] full mirror error: {e}")
                base_ok = False
            if not DRY_RUN:
                base_ok = terminal_heartbeat(
                    base_url,
                    base_ok,
                    None if base_ok else "One or more Gati sync stages failed",
                ) and base_ok
            run_ok = run_ok and base_ok
    except Exception as exc:
        run_ok = False
        log.error(f"Gati sync failed: {exc}")
        if not DRY_RUN:
            for base_url in BACKENDS:
                terminal_heartbeat(base_url, False, exc)
    finally:
        conn.close()
    log.info("Sync complete" if run_ok else "Sync incomplete")
    log.info("=" * 50)
    return run_ok


if __name__ == "__main__":
    import argparse, time
    ap = argparse.ArgumentParser(
        description="Eclat sync agent. Read-only against SQL Server.",
        epilog="Typical first run:  python sync_sjep.py --dry-run   "
               "then  --limit 25   then a full run.",
    )
    ap.add_argument("--loop", type=int, default=0, help="run every X minutes (0=once)")
    ap.add_argument("--test", action="store_true", help="test connectivity then exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="read and report row counts + data problems; upload NOTHING")
    ap.add_argument("--limit", type=int, default=0, metavar="N",
                    help="send at most N rows per entity (watermark is not advanced)")
    ap.add_argument("--only", default="", metavar="LIST",
                    help="comma-separated entities to sync, e.g. "
                         "parties,products,stock  (watermark is not advanced)")
    # ── Controlled sync (Phase 12): try ONE store / ONE entity / a few rows first.
    # All three keep the run `partial`, so the real watermark is NEVER advanced;
    # uploads stay idempotent (backend upserts on legacyId).
    ap.add_argument("--sample", action="store_true",
                    help="controlled trial: sync a few rows (implies --limit 10 if "
                         "no --limit given), NEVER advance the watermark, and print a "
                         "per-batch attribution + upsert/skip breakdown")
    ap.add_argument("--store", default="", metavar="BRANCHID",
                    help="only rows resolving to this branch legacyId "
                         "(EclatBranchId); watermark not advanced")
    ap.add_argument("--entity", default="", metavar="NAME",
                    help="restrict to ONE extractor, e.g. sales. Aliases: "
                         "customers=parties, payments=ledger, manufacturing=orders. "
                         "Watermark not advanced")
    # These are read from sys.argv inside sync_once(); register them here too so
    # argparse accepts (rather than rejects) them as recognised flags.
    ap.add_argument("--no-mirror", action="store_true",
                    help="skip the full raw-table mirror (also SJEP_SKIP_MIRROR=1)")
    ap.add_argument("--no-staff", action="store_true",
                    help="skip importing Gati staff — use once staff self-register "
                         "in-app (also SJEP_SKIP_STAFF=1)")
    args = ap.parse_args()

    DRY_RUN = args.dry_run
    LIMIT = max(0, args.limit)
    ONLY = [e.strip() for e in args.only.split(",") if e.strip()]
    SAMPLE = args.sample
    STORE = args.store.strip()
    ENTITY = args.entity.strip()
    # A sample must be bounded even if the operator forgot --limit.
    if SAMPLE and LIMIT == 0:
        LIMIT = 10
    # --entity is the singular restrictor and overrides --only. Map the discovery
    # vocabulary onto the batch names used inside sync_once().
    if ENTITY:
        _alias = {"customers": "parties", "payments": "ledger", "manufacturing": "orders"}
        ONLY = [_alias.get(ENTITY.lower(), ENTITY.lower())]

    # Ctrl+C is a normal way to end this program — the shop data is pushed and
    # its watermark advanced long before the slow full mirror starts, so stopping
    # during the mirror is expected rather than exceptional. Without this, Python
    # prints forty lines of stack trace ending in KeyboardInterrupt, which to
    # anyone standing at the machine reads as "I have broken something".
    try:
        with install_run_lock("data sync"):
            if args.test:
                sys.exit(0 if run_test() else 1)
            if args.loop > 0:
                log.info(f"Auto Sync — every {args.loop} min. Ctrl+C to stop.")
                while True:
                    if not sync_once():
                        log.error("Sync cycle failed; exiting nonzero for the scheduler.")
                        sys.exit(1)
                    log.info(f"Next sync in {args.loop} min...")
                    time.sleep(args.loop * 60)
            else:
                sys.exit(0 if sync_once() else 1)
    except GatiRunAlreadyActive as exc:
        log.error(str(exc))
        sys.exit(2)
    except KeyboardInterrupt as exc:
        print()
        log.warning("Stopped before the Gati cycle completed.")
        log.info("Anything already sent is saved; the rest is picked up next run.")
        if not DRY_RUN:
            for base_url in BACKENDS:
                terminal_heartbeat(base_url, False, exc, phase="interrupted")
        sys.exit(130)
