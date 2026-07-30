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
REPORT     = os.path.join(HERE, "discovery_report.txt")
MAP_DRAFT  = os.path.join(HERE, "stage_map.suggested.json")

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
        out(f"\n[FATAL] Could not connect: {e}")
        out("\nCheck: SQL Server running? instance name right? login allowed?")
        _save()
        sys.exit(1)
    out(f"odbc driver   : {driver}")
    cur = conn.cursor()

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

    out("\n" + "=" * 72)
    out("DISCOVERY COMPLETE — nothing was changed, nothing was uploaded.")
    out(f"Send this file to the Eclat team: {REPORT}")
    out("=" * 72)
    conn.close()
    _save()


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
