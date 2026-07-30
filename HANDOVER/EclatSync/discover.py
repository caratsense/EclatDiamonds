"""
Eclat / CaratSense — ON-SITE DISCOVERY (read-only, changes nothing)

RUN THIS FIRST, before any sync, on the client's PC.

Two things about the legacy install cannot be known from our side, and guessing
either one silently corrupts what the client sees:

  1. `Spm_MfgOrder.OrderStatus` is an INT whose meaning is per-install, as are the
     shop-floor department ids. Guess them and every order shows the wrong
     manufacturing stage — worse than showing none, because it looks authoritative.
  2. The database stores only image FILENAMES (`Inward.ImageName` + `ImageExt`).
     The actual photo folder lives somewhere on this PC and nobody has told us
     where.

So this script reads the live database read-only, reports exactly what is there,
hunts for the photo folder, and writes a DRAFT stage map for a human to confirm.
Nothing is uploaded and nothing is written to SQL Server.

Outputs, next to this file:
  discovery_report.txt     — paste this back to the Eclat team
  stage_map.suggested.json — draft; review, rename to stage_map.json
"""
import os
import sys
import json
import logging
from datetime import datetime

SQL_SERVER = os.getenv("SJEP_SQL_SERVER", r"localhost\SQLEXPRESS")
SQL_DB     = os.getenv("SJEP_SQL_DB", "APRSSJEP")
SQL_USER   = os.getenv("SJEP_SQL_USER", "")
SQL_PASS   = os.getenv("SJEP_SQL_PASS", "")
# Optional: point straight at the photo folder if you already know it.
IMAGE_ROOT = os.getenv("SJEP_IMAGE_ROOT", "")

HERE       = os.path.dirname(os.path.abspath(__file__))
REPORT_DIR = os.path.join(HERE, "reports")
os.makedirs(REPORT_DIR, exist_ok=True)
REPORT     = os.path.join(REPORT_DIR, "discovery_report.txt")
MAP_DRAFT  = os.path.join(REPORT_DIR, "stage_map.suggested.json")

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
log = logging.getLogger("discover")

# The Windows console defaults to cp1252 and mangles anything non-ASCII into "?".
# This report is read aloud on a call, so make it legible.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

_lines = []
def out(s=""):
    print(s)
    _lines.append(str(s))


def connect():
    import pyodbc
    drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
    if not drivers:
        out("[FATAL] No SQL Server ODBC driver installed.")
        out("        Install 'ODBC Driver 17 for SQL Server' and run this again.")
        sys.exit(1)
    driver = drivers[-1]
    auth = (
        f"UID={SQL_USER};PWD={SQL_PASS};"
        if SQL_USER
        else "Trusted_Connection=yes;"
    )
    cs = (
        f"DRIVER={{{driver}}};SERVER={SQL_SERVER};DATABASE={SQL_DB};{auth}"
        "ApplicationIntent=ReadOnly;TrustServerCertificate=yes;"
    )
    return pyodbc.connect(cs, readonly=True, timeout=30), driver


def find_sql_instances():
    """Every SQL Server instance installed on THIS machine, from the registry.

    More reliable than `sqlcmd -L`, which broadcasts on the network and quietly
    returns nothing when the Browser service is off — the usual state on a
    locked-down server. The registry entry is written by the installer, so if SQL
    Server is here at all, it is listed here.
    """
    names = []
    try:
        import winreg
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                k = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL",
                    0, winreg.KEY_READ | view)
            except OSError:
                continue
            try:
                i = 0
                while True:
                    inst = winreg.EnumValue(k, i)[0]
                    # MSSQLSERVER is the DEFAULT instance and is addressed by the
                    # machine name alone — "HOST\MSSQLSERVER" does not work.
                    names.append("localhost" if inst == "MSSQLSERVER"
                                 else f"localhost\\{inst}")
                    i += 1
            except OSError:
                pass
            finally:
                winreg.CloseKey(k)
    except Exception:
        pass
    return sorted(set(names))


def list_databases_on(server):
    """Database names on `server`, or None if it cannot be reached."""
    try:
        import pyodbc
        drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
        if not drivers:
            return None
        auth = f"UID={SQL_USER};PWD={SQL_PASS};" if SQL_USER else "Trusted_Connection=yes;"
        cs = (f"DRIVER={{{drivers[-1]}}};SERVER={server};DATABASE=master;{auth}"
              "TrustServerCertificate=yes;")
        c = pyodbc.connect(cs, readonly=True, timeout=8)
        cur = c.cursor()
        cur.execute("SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name")
        out_ = [r[0] for r in cur.fetchall()]
        c.close()
        return out_
    except Exception:
        return None


def diagnose_connection(err):
    """Turn a connection failure into the next thing to type.

    A raw ODBC error tells an operator nothing actionable, and they are usually
    standing in someone else's office with the client watching. So: work out
    what is actually installed and print the exact setting to use.
    """
    low = err.lower()
    out("")
    out("  WHAT THIS MEANS")
    # Check the DATABASE error first. When the database name is wrong, SQL Server
    # reports BOTH 4060 and a generic 18456 "login failed" — so testing for the
    # login error first blames the password for what is really a wrong name, and
    # sends the operator off to bother IT for no reason.
    if "cannot open database" in low or "4060" in err:
        out("    The server was reached, but that DATABASE name does not exist")
        out("    (or this login cannot see it). The real names are listed below.")
    elif "login failed" in low or "18456" in err:
        out("    The server was reached, but the login was refused.")
        out("    -> Ask IT to run create_readonly_login.sql and use that username")
        out("       and password (run 2_configure.bat again to enter them).")
    else:
        out("    The SQL Server could not be reached at that name.")
        out("    Usually the instance name is wrong, not the password.")

    instances = find_sql_instances()
    out("")
    if not instances:
        out("  SQL SERVER INSTANCES ON THIS COMPUTER: none found.")
        out("")
        out("    SQL Server does not appear to be installed on THIS machine.")
        out("    If the jewellery software runs somewhere else — another PC, or a")
        out("    virtual machine on this one — then this agent must be installed")
        out("    THERE, or pointed at it over the network.")
        out("    Ask: 'which computer actually holds the database?'")
        _save()
        return

    out(f"  SQL SERVER INSTANCES ON THIS COMPUTER ({len(instances)}):")
    for name in instances:
        dbs = list_databases_on(name)
        if dbs is None:
            out(f"    {name:<28} (could not connect — service stopped, or no permission)")
            continue
        out(f"    {name:<28} reachable, {len(dbs)} database(s):")
        for d in dbs:
            star = "   <-- looks like the jewellery database" if (
                "aprs" in d.lower() or "sjep" in d.lower()) else ""
            out(f"      - {d}{star}")

    out("")
    out("  WHAT TO DO NEXT")
    out("    Pick the server name and database from the list above, then run")
    out("    2_configure.bat and enter them. For example:")
    best = instances[0]
    bestdb = None
    for name in instances:
        for d in (list_databases_on(name) or []):
            if "aprs" in d.lower() or "sjep" in d.lower():
                best, bestdb = name, d
                break
        if bestdb:
            break
    out(f"      SQL Server   : {best}")
    out(f"      Database name: {bestdb or '(pick from the list above)'}")


def table_exists(cur, name):
    cur.execute(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?", name
    )
    return cur.fetchone()[0] > 0


def count(cur, table):
    if not table_exists(cur, table):
        return None
    try:
        cur.execute(f"SELECT COUNT(*) FROM [{table}]")
        return cur.fetchone()[0]
    except Exception as e:
        return f"error: {e}"


def rows(cur):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def main():
    out("=" * 72)
    out("ECLAT / CARATSENSE — ON-SITE DISCOVERY (read-only)")
    out(f"run at        : {datetime.now().isoformat(timespec='seconds')}")
    out(f"sql server    : {SQL_SERVER}")
    out(f"database      : {SQL_DB}")
    out(f"auth          : {'SQL login ' + SQL_USER if SQL_USER else 'Windows (trusted)'}")
    out("=" * 72)

    try:
        conn, driver = connect()
    except Exception as e:
        out(f"\n[COULD NOT CONNECT] {e}")
        diagnose_connection(str(e))
        _save()
        sys.exit(1)
    out(f"odbc driver   : {driver}")
    cur = conn.cursor()

    # ── 0. What server and database are we actually looking at ────────────────
    # First because it is the cheapest way to catch the worst mistake: profiling a
    # stale restored copy and reporting it as the client's live system.
    out("\n" + "-" * 72)
    out("0. THE SERVER AND DATABASE")
    out("-" * 72)
    try:
        cur.execute("SELECT @@VERSION")
        ver = str(cur.fetchone()[0]).splitlines()[0]
        out(f"  SQL Server : {ver}")
    except Exception as e:
        out(f"  SQL Server : (could not read version: {str(e)[:60]})")
    try:
        cur.execute("SELECT DB_NAME(), SUSER_SNAME()")
        r = cur.fetchone()
        out(f"  Database   : {r[0]}")
        out(f"  Connected as: {r[1]}")
    except Exception:
        pass
    try:
        cur.execute("SELECT name, create_date, state_desc FROM sys.databases "
                    "WHERE database_id > 4 ORDER BY name")
        dbs = rows(cur)
        out(f"\n  Other databases on this server ({len(dbs)}):")
        for d in dbs:
            mark = "  <-- we are using this" if d["name"] == SQL_DB else ""
            out(f"    {d['name']:<28} created {str(d['create_date'])[:10]}  "
                f"{d['state_desc']}{mark}")
        if len(dbs) > 1:
            out("\n    ! More than one database here. Confirm with the client which one")
            out("      the shop actually USES day to day — a restored backup or a")
            out("      test copy sitting alongside it looks identical from here.")
    except Exception as e:
        out(f"  (could not list databases: {str(e)[:60]})")

    try:
        cur.execute("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'")
        out(f"\n  Tables in this database: {cur.fetchone()[0]}")
    except Exception:
        pass

    # The biggest tables tell you what this shop actually does, and what the
    # first sync will spend its time on.
    out("\n  Largest tables by row count:")
    try:
        cur.execute("""
            SELECT TOP 15 t.name AS table_name, SUM(p.rows) AS row_count
            FROM sys.tables t
            JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0,1)
            GROUP BY t.name ORDER BY SUM(p.rows) DESC""")
        for r in rows(cur):
            out(f"    {r['table_name']:<34} {r['row_count']:>10,}")
    except Exception as e:
        out(f"    (unavailable: {str(e)[:60]})")

    # ── 1. How much data is actually here ──────────────────────────────────────
    out("\n" + "-" * 72)
    out("1. ROW COUNTS (what we would be importing)")
    out("-" * 72)
    for t in [
        "PartyMst", "StyleMst", "Inward", "InwardHistory", "JewelTrans",
        "Spm_MfgOrder", "SPM_MfgOrderItem", "OrderProceed", "OrderProceedItem",
        "SPM_BagMaster", "SPM_BagTransaction", "SPM_DepartmentMst", "Journal",
    ]:
        c = count(cur, t)
        out(f"  {t:<24} {'(table not present)' if c is None else c}")

    # ── 2. The order-status codes actually in use ──────────────────────────────
    out("\n" + "-" * 72)
    out("2. Spm_MfgOrder.OrderStatus — THE CODES THIS INSTALL ACTUALLY USES")
    out("   (a human must say what each number means)")
    out("-" * 72)
    order_codes = []
    if table_exists(cur, "Spm_MfgOrder"):
        try:
            cur.execute(
                "SELECT OrderStatus, COUNT(*) AS n, MIN(OrderDate) AS first_seen, "
                "MAX(OrderDate) AS last_seen FROM Spm_MfgOrder "
                "GROUP BY OrderStatus ORDER BY n DESC"
            )
            for r in rows(cur):
                order_codes.append(r["OrderStatus"])
                out(f"  OrderStatus = {str(r['OrderStatus']):<6} {r['n']:>6} orders   "
                    f"{str(r['first_seen'])[:10]} .. {str(r['last_seen'])[:10]}")
        except Exception as e:
            out(f"  [warn] {e}")
    else:
        out("  (Spm_MfgOrder not present)")

    # ── 3. Departments — the real manufacturing timeline ───────────────────────
    out("\n" + "-" * 72)
    out("3. SHOP-FLOOR DEPARTMENTS — these become the manufacturing timeline")
    out("-" * 72)
    departments = []
    if table_exists(cur, "SPM_DepartmentMst"):
        try:
            cur.execute("SELECT * FROM SPM_DepartmentMst")
            for r in rows(cur):
                did = r.get("DepartmentId") or r.get("Id")
                name = (
                    r.get("DepartmentName") or r.get("Department")
                    or r.get("Name") or r.get("Descr") or ""
                )
                departments.append({"id": did, "name": str(name).strip()})
                out(f"  DepartmentId = {str(did):<6} {name}")
        except Exception as e:
            out(f"  [warn] {e}")
    else:
        out("  (SPM_DepartmentMst not present)")

    if table_exists(cur, "SPM_BagMaster"):
        out("\n  Bags currently sitting in each department:")
        try:
            cur.execute(
                "SELECT DepartmentId, COUNT(*) AS n FROM SPM_BagMaster "
                "GROUP BY DepartmentId ORDER BY n DESC"
            )
            for r in rows(cur):
                out(f"    DepartmentId = {str(r['DepartmentId']):<6} {r['n']:>5} bags")
        except Exception as e:
            out(f"    [warn] {e}")
        out("\n  Distinct BagStatus values:")
        try:
            cur.execute(
                "SELECT BagStatus, COUNT(*) AS n FROM SPM_BagMaster "
                "GROUP BY BagStatus ORDER BY n DESC"
            )
            for r in rows(cur):
                out(f"    BagStatus = {str(r['BagStatus']):<10} {r['n']:>5}")
        except Exception as e:
            out(f"    [warn] {e}")

    # ── 3b. The other timeline sources, and a verdict ──────────────────────────
    out("\n  Order-to-delivery bridge (OrderProceedItem.OrderProceedStatus):")
    proceed_codes = 0
    if table_exists(cur, "OrderProceedItem"):
        try:
            cur.execute(
                "SELECT OrderProceedStatus, COUNT(*) AS n FROM OrderProceedItem "
                "GROUP BY OrderProceedStatus ORDER BY n DESC"
            )
            res = rows(cur)
            proceed_codes = len(res)
            for r in res:
                out(f"    OrderProceedStatus = {str(r['OrderProceedStatus']):<8} {r['n']:>5}")
        except Exception as e:
            out(f"    [warn] {e}")
    else:
        out("    (OrderProceedItem not present)")

    out("\n  Bag movements over time (SPM_BagTransaction):")
    bag_txns = count(cur, "SPM_BagTransaction")
    out(f"    {bag_txns if bag_txns is not None else '(table not present)'} rows")

    # A plain verdict, so nobody has to infer it from the numbers above.
    out("\n  --- CAN THIS INSTALL SHOW A MANUFACTURING TIMELINE? ---")
    real_departments = [d for d in departments if (d.get("name") or "").strip().lower() not in ("", "self")]
    distinct_order_codes = len([c for c in order_codes if c is not None])
    if len(real_departments) >= 2:
        out(f"    YES — {len(real_departments)} real departments to map. Confirm each")
        out("    one's Eclat stage in the draft map and the timeline will populate.")
    elif proceed_codes >= 2:
        out("    PARTLY — there are no real shop-floor departments (only a placeholder),")
        out(f"    but OrderProceedItem has {proceed_codes} distinct status codes. Ask how")
        out("    the client tracks work-in-progress; that field may be the timeline.")
    elif distinct_order_codes >= 2:
        out(f"    PARTLY — no department structure, but OrderStatus has {distinct_order_codes}")
        out("    distinct values. Decode them with the client.")
    else:
        out("    NO — this install has no department structure, one order-status value,")
        out("    and no proceed codes. Orders will import correctly and show as 'booked',")
        out("    but there is no per-stage progress recorded in the source system to show.")
        out("    TELL THE CLIENT THIS PLAINLY rather than shipping an empty timeline:")
        out("    tracking stages would mean they start recording them somewhere.")

    # ── 4. Photos: what the DB names, and where the files really are ───────────
    out("\n" + "-" * 72)
    out("4. CATALOGUE PHOTOS")
    out("-" * 72)
    samples = []
    for table, namecol, extcol in [
        ("Inward", "ImageName", "ImageExt"),
        ("StyleMst", "ImageName", "ImageExt"),
    ]:
        if not table_exists(cur, table):
            continue
        try:
            cur.execute(f"SELECT TOP 0 * FROM [{table}]")
            cols = {c[0].lower() for c in cur.description}
            if namecol.lower() not in cols:
                out(f"  {table}: no {namecol} column on this version")
                continue
            cur.execute(
                f"SELECT COUNT(*) FROM [{table}] WHERE [{namecol}] IS NOT NULL "
                f"AND LTRIM(RTRIM([{namecol}])) <> ''"
            )
            n = cur.fetchone()[0]
            total = count(cur, table)
            out(f"  {table}: {n} of {total} rows name an image")
            sel = f"[{namecol}]" + (f", [{extcol}]" if extcol.lower() in cols else "")
            cur.execute(
                f"SELECT TOP 15 {sel} FROM [{table}] WHERE [{namecol}] IS NOT NULL "
                f"AND LTRIM(RTRIM([{namecol}])) <> ''"
            )
            for r in rows(cur):
                nm = str(r.get(namecol) or "").strip()
                ex = str(r.get(extcol) or "").strip() if extcol.lower() in cols else ""
                if nm:
                    samples.append(nm + (ex if ex.startswith(".") else (f".{ex}" if ex else "")))
            for s in samples[:8]:
                out(f"      e.g. {s}")
        except Exception as e:
            out(f"  {table}: [warn] {e}")

    out("\n  Looking for the folder these files live in...")
    found_root, found_example = find_image_root(samples)
    if found_root:
        out(f"  [FOUND] {found_root}")
        out(f"          matched: {found_example}")
        out("\n  >>> Put this in eclat_config.bat:")
        out(f'      set SJEP_IMAGE_ROOT={found_root}')
    else:
        out("  [NOT FOUND] Could not locate the photo folder automatically.")
        out("  Ask the shop: 'where are the jewellery photos kept?' Then set")
        out("  SJEP_IMAGE_ROOT in eclat_config.bat to that folder and re-run.")
        out("  (Searched the common install paths; a network drive or a custom")
        out("   folder will not be found automatically.)")

    # ── 5. Draft stage map ─────────────────────────────────────────────────────
    draft = build_stage_map_draft(order_codes, departments)
    with open(MAP_DRAFT, "w", encoding="utf-8") as f:
        json.dump(draft, f, indent=2, ensure_ascii=False)

    out("\n" + "-" * 72)
    out("5. DRAFT STAGE MAP")
    out("-" * 72)
    out(f"  Written to: {MAP_DRAFT}")
    out("  Every entry guessed from the department NAME is marked \"guess\": true.")
    out("  A human must confirm each one, then save the file as stage_map.json.")
    out("  Anything left null simply records the movement without moving the order.")

    profile_branch_attribution(cur)
    sample_key_tables(cur)

    out("\n" + "=" * 72)
    out("DISCOVERY COMPLETE — nothing was changed, nothing was uploaded.")
    out(f"Send this file to the Eclat team: {REPORT}")
    out("=" * 72)
    conn.close()
    _save()


# ── Sample records ────────────────────────────────────────────────────────────
# Counts tell you how much there is; samples tell you whether it is what you think
# it is. A "customer" table full of blank names, or amounts stored as text, or
# dates in 1900 — none of that shows up in a row count, and all of it changes what
# the client sees. Five real rows per table catches it in seconds.

SAMPLE_TABLES = [
    ("PartyMst",      ["PartyNo", "FirmName", "FirmCity", "IsCustomer", "IsSalesMan",
                       "IsLocation", "BranchNo"]),
    ("StyleMst",      ["StyleId", "StyleCode", "StyleSKUNo", "ImageName"]),
    ("Inward",        ["JewelId", "JewelCode", "InwardSKUNo", "StyleId", "LocationId",
                       "BranchNo", "InwardDate", "Status", "ImageName"]),
    ("JewelTrans",    ["JewelTransId", "JewelTransNo", "JewelTransDate", "PartyNo",
                       "BookNo", "Amount", "TranType", "isCancel"]),
    ("Spm_MfgOrder",  ["OrderId", "OrderNo", "OrderDate", "OrderStatus", "BookNo",
                       "CustomerId", "Amount"]),
    ("SPM_BagMaster", ["BagId", "BagNo", "OrderId", "DepartmentId", "BagStatus",
                       "BagDate"]),
]


def _fmt(v, width=22):
    if v is None:
        return "NULL"
    s = str(v).strip().replace("\n", " ")
    return s[:width] + ("…" if len(s) > width else "")


def sample_key_tables(cur):
    out("\n" + "=" * 72)
    out("SAMPLE RECORDS — does the data look like what we think it is?")
    out("=" * 72)
    out("")
    out("  Read these with the client. Look for: blank names, zero amounts,")
    out("  dates that make no sense, codes nobody recognises.")
    out("")

    for table, wanted in SAMPLE_TABLES:
        if not table_exists(cur, table):
            out(f"  {table}: (not present)\n")
            continue
        try:
            cur.execute(f"SELECT TOP 0 * FROM [{table}]")
            have = {str(d[0]).lower(): str(d[0]) for d in cur.description}
            cols = [have[w.lower()] for w in wanted if w.lower() in have]
            if not cols:
                out(f"  {table}: none of the expected columns exist "
                    f"(has {len(have)} columns)\n")
                continue
            sel = ", ".join(f"[{c}]" for c in cols)
            cur.execute(f"SELECT TOP 5 {sel} FROM [{table}]")
            data = rows(cur)
            out(f"  {table}  —  showing {len(data)} row(s), "
                f"{len(cols)} of {len(have)} columns")
            if not data:
                out("    (table is EMPTY)\n")
                continue
            header = "  ".join(f"{c[:22]:<22}" for c in cols)
            out(f"    {header}")
            out(f"    {'-' * len(header)}")
            for r in data:
                out("    " + "  ".join(f"{_fmt(r.get(c)):<22}" for c in cols))
            # Blank-name check: the single most common nasty surprise.
            for name_col in ("FirmName", "StyleCode", "JewelCode"):
                if name_col in cols:
                    cur.execute(
                        f"SELECT COUNT(*) FROM [{table}] "
                        f"WHERE [{name_col}] IS NULL OR LTRIM(RTRIM([{name_col}])) = ''")
                    blank = cur.fetchone()[0]
                    if blank:
                        out(f"    ! {blank} row(s) have a BLANK {name_col} — "
                            f"these will show as unnamed in Eclat")
            out("")
        except Exception as e:
            out(f"  {table}: could not sample — {str(e)[:70]}\n")


# ── Branch attribution ────────────────────────────────────────────────────────
# Which column says "this row belongs to THIS shop"? Get it wrong and every
# per-branch number in the product is wrong in a way that looks plausible, so this
# is measured rather than assumed.
#
# The tables split into two kinds:
#   * Inward / PartyMst carry location columns directly (often several).
#   * JewelTrans / Spm_MfgOrder carry none — their only link to a place is
#     BookNo -> BookMaster, on the assumption that each branch keeps its own
#     document series. That assumption is exactly what this checks.

BRANCH_CANDIDATES = {
    "Inward":       ["LocationId", "BranchNo", "FirstLocationId", "CompanyId"],
    "PartyMst":     ["BranchNo", "LocationId"],
    "JewelTrans":   ["BranchNo", "LocationId", "BookNo"],
    "Spm_MfgOrder": ["BranchNo", "LocationId", "BookNo"],
    "SPM_BagMaster": ["CompanyId", "BranchNo"],
    "Journal":      ["BranchNo", "LocationId", "BookNo"],
}


def profile_branch_attribution(cur):
    out("\n" + "=" * 72)
    out("BRANCH ATTRIBUTION — which column tells us the shop?")
    out("=" * 72)
    out("")
    out("  This decides whether each branch gets its own sales, stock and orders,")
    out("  or whether everything piles into one store. Read it with the client.")
    out("")

    # 1. How many branches are there, and what are they called?
    branches = {}
    if table_exists(cur, "PartyMst"):
        cur.execute("SELECT TOP 0 * FROM PartyMst")
        cols = {str(d[0]).lower(): str(d[0]) for d in cur.description}
        flags = [c for c in ("islocation", "isfactory") if c in cols]
        name_col = cols.get("firmname") or cols.get("legalname")
        pk = cols.get("partyno")
        if flags and name_col and pk:
            where = " OR ".join(f"{cols[f]} = 1" for f in flags)
            cur.execute(f"SELECT {pk} AS id, {name_col} AS name FROM PartyMst WHERE {where}")
            for r in rows(cur):
                branches[str(r["id"]).strip()] = str(r.get("name") or "").strip()
            out(f"  Branch/location rows in PartyMst: {len(branches)}")
            for bid, bname in list(branches.items())[:25]:
                out(f"    - [{bid}] {bname}")
            if len(branches) > 25:
                out(f"    ... and {len(branches) - 25} more")
        else:
            out("  ! PartyMst has no IsLocation/IsFactory flag — branches cannot be "
                "detected automatically.")
    out("")

    if len(branches) <= 1:
        out("  >> Only one branch found. Per-branch reporting is not meaningful here;")
        out("     everything will sit in a single store. If the client says they run")
        out("     several shops, this flag is wrong — ASK before syncing.")
        out("")

    # 2. For each table, how well does each candidate column actually cover it?
    for table, cands in BRANCH_CANDIDATES.items():
        if not table_exists(cur, table):
            continue
        cur.execute(f"SELECT TOP 0 * FROM {table}")
        cols = {str(d[0]).lower(): str(d[0]) for d in cur.description}
        total = count(cur, table)
        # count() returns None (missing table) or an "error: ..." string on
        # failure; only a real integer can be divided by below.
        if not isinstance(total, int) or total == 0:
            continue
        out(f"  {table} ({total} rows)")
        found_any = False
        for cand in cands:
            col = cols.get(cand.lower())
            if not col:
                continue
            found_any = True
            try:
                cur.execute(
                    f"SELECT COUNT(*) AS filled, COUNT(DISTINCT {col}) AS distinct_vals "
                    f"FROM {table} WHERE {col} IS NOT NULL")
                r = rows(cur)[0]
                filled, distinct = r["filled"], r["distinct_vals"]
                pct = (filled * 100 // total) if total else 0
                # Does it point at things we believe are branches?
                cur.execute(
                    f"SELECT TOP 10 {col} AS v, COUNT(*) AS n FROM {table} "
                    f"WHERE {col} IS NOT NULL GROUP BY {col} ORDER BY COUNT(*) DESC")
                top = rows(cur)
                known = sum(1 for t in top if str(t["v"]).strip() in branches)
                spread = ", ".join(
                    f"{str(t['v']).strip()}"
                    + (f"={branches[str(t['v']).strip()]}" if str(t['v']).strip() in branches else "")
                    + f" ({t['n']})"
                    for t in top[:5])
                verdict = ""
                if distinct <= 1:
                    verdict = "  <- SAME VALUE EVERYWHERE, useless for splitting"
                elif cand == "BookNo":
                    # BookNo is a DOCUMENT-SERIES id, not a branch id, so comparing
                    # it against the branch list always "fails". It is meant to be
                    # resolved one hop further, through BookMaster — see below.
                    verdict = "  <- document series; resolved via BookMaster (see below)"
                elif branches and known == 0:
                    verdict = "  <- values are not in the branch list above"
                elif pct < 50:
                    verdict = f"  <- only {pct}% of rows have it"
                out(f"    {col:<18} filled {pct:>3}%  distinct {distinct:<5}{verdict}")
                if spread:
                    out(f"      top: {spread}")
            except Exception as e:
                out(f"    {col:<18} could not profile: {str(e)[:60]}")
        if not found_any:
            out("    (no direct branch column — must go through BookMaster, see below)")
        out("")

    # 3. Is the document book per-branch? This is what sales/orders rely on.
    out("  BookMaster — the fallback path for sales and orders")
    if not table_exists(cur, "BookMaster"):
        out("    ! BookMaster not found. Sales/orders cannot be split by branch.")
    else:
        cur.execute("SELECT TOP 0 * FROM BookMaster")
        cols = {str(d[0]).lower(): str(d[0]) for d in cur.description}
        branch_col = next((cols[c] for c in
                           ("branchno", "locationid", "companyid", "branchid", "partyno")
                           if c in cols), None)
        if not branch_col:
            out("    ! BookMaster has NO branch column "
                f"(has: {', '.join(sorted(cols.values()))[:200]})")
            out("    >> Sales and orders CANNOT be attributed to a branch on this")
            out("       install. They will all land in the default store. Raise this")
            out("       with the client before syncing — it may mean per-branch sales")
            out("       figures are not achievable from this data.")
        else:
            cur.execute(f"SELECT COUNT(*) AS n, COUNT(DISTINCT {branch_col}) AS d "
                        f"FROM BookMaster WHERE {branch_col} IS NOT NULL")
            r = rows(cur)[0]
            out(f"    branch column: {branch_col} — {r['n']} books, "
                f"{r['d']} distinct branch value(s)")
            if r["d"] <= 1:
                out("    >> Every book points at the SAME branch, so books cannot")
                out("       separate the shops. Sales/orders will not split.")
            else:
                out("    >> Books look per-branch. Sales and orders can be attributed.")
    out("")
    out("  WHAT THE ECLAT TEAM NEEDS FROM THIS:")
    out("    1. The number of branches above must match what the client actually runs.")
    out("    2. For each table, the column with high fill %, >1 distinct value, and")
    out("       values that ARE branch ids is the one to use.")
    out("    3. If nothing qualifies for sales/orders, say so out loud — per-branch")
    out("       revenue then cannot come from this system without new data entry.")


# Eclat's production stages, in order.
ECLAT_STAGES = [
    "booked", "designing", "casting", "stone_setting",
    "polishing", "qc", "ready", "delivered",
]

# Department-name keywords -> Eclat stage. Only a starting point: the operator
# confirms every guess, because a shop's "finishing" might mean polishing or QC.
KEYWORDS = [
    (("design", "cad", "cam", "drawing"),            "designing"),
    (("wax", "cast", "casting", "tree", "melt"),     "casting"),
    (("set", "setting", "stone", "diamond", "jadai"),"stone_setting"),
    (("polish", "buff", "finish", "rhodium", "plat"),"polishing"),
    (("qc", "quality", "check", "inspect", "hallmark"), "qc"),
    (("ready", "complete", "final", "dispatch", "pack"), "ready"),
    (("deliver", "sold", "issue"),                   "delivered"),
]


def guess_stage(name: str):
    low = (name or "").lower()
    for keys, stage in KEYWORDS:
        if any(k in low for k in keys):
            return stage
    return None


def build_stage_map_draft(order_codes, departments):
    return {
        "_README": [
            "Maps this install's own codes to Eclat's manufacturing stages.",
            "Confirm every entry, then save this file as stage_map.json.",
            "Valid stages: " + ", ".join(ECLAT_STAGES),
            "null = record the movement but do not advance the order.",
        ],
        "orderStatusToStage": {
            str(c): {"stage": None, "guess": False, "note": "confirm with the client"}
            for c in order_codes
            if c is not None
        },
        "departmentToStage": {
            str(d["id"]): {
                "name": d["name"],
                "stage": guess_stage(d["name"]),
                "guess": guess_stage(d["name"]) is not None,
            }
            for d in departments
            if d.get("id") is not None
        },
    }


def find_image_root(samples):
    """Hunt for the folder holding the sampled filenames.

    Bounded on purpose: walking every drive on a shop PC can take many minutes and
    this runs while someone waits on an AnyDesk call. If it misses, the operator
    sets SJEP_IMAGE_ROOT by hand — which is why the report says so explicitly
    rather than leaving a silent blank.
    """
    wanted = {s.lower() for s in samples if s}
    if not wanted:
        return None, None

    roots = []
    if IMAGE_ROOT:
        roots.append(IMAGE_ROOT)
    for base in [
        os.getenv("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        os.getenv("ProgramFiles", r"C:\Program Files"),
        r"C:\APRS", r"C:\SJEP", r"C:\SJEPlus", r"C:\Gati",
        r"D:\APRS", r"D:\SJEP", r"D:\SJEPlus", r"D:\Gati",
        r"C:\\", r"D:\\",
    ]:
        if base and os.path.isdir(base) and base not in roots:
            roots.append(base)

    for root in roots:
        depth_limit = 6 if root not in (r"C:\\", r"D:\\") else 3
        base_depth = root.rstrip("\\/").count(os.sep)
        try:
            for dirpath, dirnames, filenames in os.walk(root, topdown=True):
                if dirpath.count(os.sep) - base_depth >= depth_limit:
                    dirnames[:] = []
                    continue
                # Skip the noisy, certainly-irrelevant trees.
                dirnames[:] = [
                    d for d in dirnames
                    if d.lower() not in {
                        "windows", "$recycle.bin", "system volume information",
                        "node_modules", "appdata", "temp", "tmp",
                    }
                ]
                lower = {f.lower() for f in filenames}
                hit = wanted & lower
                if hit:
                    return dirpath, sorted(hit)[0]
        except (PermissionError, OSError):
            continue
    return None, None


def _save():
    try:
        with open(REPORT, "w", encoding="utf-8") as f:
            f.write("\n".join(_lines))
    except Exception as e:
        print(f"[warn] could not write {REPORT}: {e}")


if __name__ == "__main__":
    main()
