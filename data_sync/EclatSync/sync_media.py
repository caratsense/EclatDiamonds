"""
Eclat / CaratSense — CATALOGUE PHOTO SYNC

Uploads the shop's jewellery photographs to Cloudinary and tells Eclat where they
landed, so the catalogue shows the real piece instead of a grey placeholder.

Flow, per image:
    SQL Server names the file  ->  find it on this PC  ->  upload to Cloudinary
    ->  POST {legacyId, imageUrl} to Eclat

The bytes go STRAIGHT from this PC to Cloudinary — they never pass through the
Eclat backend. That matters: a jewellery catalogue is tens of GB of camera JPEGs,
and routing it through the API would be slow, would be billed as egress twice,
and would hit request-size limits. Eclat only ever receives the resulting link.

Safe to re-run. An `uploaded_media.json` ledger records what has already gone up,
so a second run only does what is new. Delete that file to force a full re-upload.

Run:  sync_media.bat        (or: python sync_media.py [--limit N] [--dry-run])
"""
import os
import sys
import json
import time
import hashlib
import logging
from datetime import datetime, date
from decimal import Decimal

import requests

# ── Config (from eclat_config.bat) ────────────────────────────────────────────
BACKENDS   = [u.strip().rstrip("/") for u in os.getenv("ECLAT_BASE_URL", "").split(",") if u.strip()]
EMAIL      = os.getenv("ECLAT_EMAIL", "")
PASSWORD   = os.getenv("ECLAT_PASSWORD", "")

SQL_SERVER = os.getenv("SJEP_SQL_SERVER", r"localhost\SQLEXPRESS")
SQL_DB     = os.getenv("SJEP_SQL_DB", "APRSSJEP")
SQL_USER   = os.getenv("SJEP_SQL_USER", "")
SQL_PASS   = os.getenv("SJEP_SQL_PASS", "")

IMAGE_ROOT = os.getenv("SJEP_IMAGE_ROOT", "")

CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME", "")
CLOUD_KEY  = os.getenv("CLOUDINARY_API_KEY", "")
CLOUD_SEC  = os.getenv("CLOUDINARY_API_SECRET", "")

HERE      = os.path.dirname(os.path.abspath(__file__))
LEDGER    = os.path.join(HERE, "uploaded_media.json")
LOG_FILE  = os.path.join(HERE, "media_sync.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("eclat-media")

DRY_RUN = "--dry-run" in sys.argv
LIMIT = None
for i, a in enumerate(sys.argv):
    if a == "--limit" and i + 1 < len(sys.argv):
        LIMIT = int(sys.argv[i + 1])

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


def fail(msg):
    log.error(msg)
    sys.exit(1)


def check_config():
    if not BACKENDS or not EMAIL or not PASSWORD:
        fail("Eclat settings missing. Run this through sync_media.bat so eclat_config.bat loads.")
    if not (CLOUD_NAME and CLOUD_KEY and CLOUD_SEC):
        fail(
            "Cloudinary settings missing. Add these to eclat_config.bat:\n"
            "  set CLOUDINARY_CLOUD_NAME=...\n"
            "  set CLOUDINARY_API_KEY=...\n"
            "  set CLOUDINARY_API_SECRET=...\n"
            "(Cloudinary dashboard -> Settings -> API Keys)"
        )
    if not IMAGE_ROOT or not os.path.isdir(IMAGE_ROOT):
        fail(
            f"SJEP_IMAGE_ROOT is not set or does not exist ({IMAGE_ROOT!r}).\n"
            "Run discover.bat first — it hunts for the photo folder and prints the\n"
            "exact line to paste into eclat_config.bat."
        )


# ── Ledger: what has already been uploaded ────────────────────────────────────
def load_ledger():
    try:
        with open(LEDGER, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_ledger(d):
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, LEDGER)


# ── Sources ───────────────────────────────────────────────────────────────────
def connect_sql():
    import pyodbc
    drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
    if not drivers:
        fail("No SQL Server ODBC driver. Install 'ODBC Driver 17 for SQL Server'.")
    auth = f"UID={SQL_USER};PWD={SQL_PASS};" if SQL_USER else "Trusted_Connection=yes;"
    cs = (
        f"DRIVER={{{drivers[-1]}}};SERVER={SQL_SERVER};DATABASE={SQL_DB};{auth}"
        "ApplicationIntent=ReadOnly;TrustServerCertificate=yes;"
    )
    return pyodbc.connect(cs, readonly=True, timeout=30)


def rows(cur):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def has_col(cur, table, col):
    cur.execute(f"SELECT TOP 0 * FROM [{table}]")
    return col.lower() in {c[0].lower() for c in cur.description}


def collect_targets(cur):
    """Every (kind, legacyId, filename) the database names an image for.

    `kind` picks the Eclat table: StyleMst is the design master -> Product,
    Inward is the physical piece -> StockItem. Both are worth having; the piece
    photo is the one a customer recognises, the style render is the fallback.
    """
    targets = []
    for table, key, kind in [("StyleMst", "StyleId", "product"), ("Inward", "JewelId", "stock")]:
        try:
            cur.execute(f"SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='{table}'")
            if cur.fetchone()[0] == 0:
                continue
            if not has_col(cur, table, "ImageName"):
                log.info(f"  {table}: no ImageName column — skipping")
                continue
            ext = "ImageExt" if has_col(cur, table, "ImageExt") else None
            sel = f"[{key}], [ImageName]" + (f", [{ext}]" if ext else "")
            cur.execute(
                f"SELECT {sel} FROM [{table}] "
                f"WHERE [ImageName] IS NOT NULL AND LTRIM(RTRIM([ImageName])) <> ''"
            )
            n = 0
            for r in rows(cur):
                name = str(r.get("ImageName") or "").strip()
                if not name:
                    continue
                e = str(r.get(ext) or "").strip() if ext else ""
                if e and not name.lower().endswith(tuple(IMAGE_EXTS)):
                    name = name + (e if e.startswith(".") else "." + e)
                targets.append({"kind": kind, "legacyId": str(r[key]), "filename": name})
                n += 1
            log.info(f"  {table}: {n} rows name an image")
        except Exception as e:
            log.warning(f"  {table}: {e}")
    return targets


def build_file_index(root):
    """One walk of the photo folder -> {lowercase filename: full path}.

    Indexing up front beats searching per image: a catalogue has thousands of
    rows and the folder is often on a slow or network disk, so one pass is the
    difference between minutes and hours.
    """
    log.info(f"Indexing photos under {root} ...")
    index = {}
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in IMAGE_EXTS:
                index.setdefault(fn.lower(), os.path.join(dirpath, fn))
                count += 1
    log.info(f"  indexed {count} image files ({len(index)} distinct names)")
    return index


def resolve(index, filename):
    """Find a file, tolerating a missing/incorrect extension in the DB."""
    direct = index.get(filename.lower())
    if direct:
        return direct
    stem = os.path.splitext(filename)[0].lower()
    for ext in IMAGE_EXTS:
        hit = index.get(stem + ext)
        if hit:
            return hit
    return None


# ── Cloudinary ────────────────────────────────────────────────────────────────
def cloudinary_upload(path, public_id):
    """Signed upload. Returns the CDN url.

    `overwrite=false` + a stable public_id makes a repeat upload a no-op on
    Cloudinary's side too, so a re-run costs nothing even if the local ledger
    was deleted.
    """
    ts = int(time.time())
    params = {
        "folder": "eclat/catalogue",
        "overwrite": "false",
        "public_id": public_id,
        "timestamp": str(ts),
        "unique_filename": "false",
        "use_filename": "false",
    }
    to_sign = "&".join(f"{k}={params[k]}" for k in sorted(params))
    signature = hashlib.sha1((to_sign + CLOUD_SEC).encode("utf-8")).hexdigest()

    with open(path, "rb") as fh:
        files = {"file": (os.path.basename(path), fh)}
        data = dict(params)
        data["api_key"] = CLOUD_KEY
        data["signature"] = signature
        r = requests.post(
            f"https://api.cloudinary.com/v1_1/{CLOUD_NAME}/auto/upload",
            data=data, files=files, timeout=180,
        )
    if not (200 <= r.status_code < 300):
        raise RuntimeError(f"Cloudinary {r.status_code}: {r.text[:200]}")
    return r.json()["secure_url"]


# ── Eclat ─────────────────────────────────────────────────────────────────────
def login(base_url):
    r = requests.post(
        f"{base_url}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["token"]


def push_images(token, base_url, records):
    if not records:
        return True
    ok = True
    hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    for i in range(0, len(records), 500):
        chunk = records[i:i + 500]
        try:
            r = requests.post(
                f"{base_url}/sync/product-images",
                headers=hdrs, data=json.dumps({"records": chunk}), timeout=180,
            )
            if 200 <= r.status_code < 300:
                res = r.json()
                log.info(f"  linked {res.get('upserted')} images (skipped {res.get('skipped')})")
            else:
                log.error(f"  link FAILED {r.status_code}: {r.text[:200]}")
                ok = False
        except Exception as e:
            log.error(f"  link error: {e}")
            ok = False
    return ok


def main():
    log.info("=" * 66)
    log.info("ECLAT CATALOGUE PHOTO SYNC")
    log.info("=" * 66)
    check_config()

    conn = connect_sql()
    cur = conn.cursor()
    log.info("Reading image references from SQL Server...")
    targets = collect_targets(cur)
    conn.close()
    if not targets:
        log.info("No image references found. Nothing to do.")
        return 0

    index = build_file_index(IMAGE_ROOT)
    ledger = load_ledger()

    todo = [t for t in targets if f"{t['kind']}:{t['legacyId']}" not in ledger]
    log.info(f"{len(targets)} referenced, {len(targets) - len(todo)} already uploaded, {len(todo)} to do")
    if LIMIT:
        todo = todo[:LIMIT]
        log.info(f"  --limit {LIMIT}: doing {len(todo)} this run")

    uploaded, missing, failed = [], 0, 0
    for n, t in enumerate(todo, 1):
        key = f"{t['kind']}:{t['legacyId']}"
        path = resolve(index, t["filename"])
        if not path:
            missing += 1
            if missing <= 10:
                log.warning(f"  not on disk: {t['filename']} ({key})")
            continue
        if DRY_RUN:
            log.info(f"  [dry-run] would upload {path}")
            continue
        try:
            public_id = f"{t['kind']}_{t['legacyId']}"
            url = cloudinary_upload(path, public_id)
            ledger[key] = {"url": url, "file": t["filename"], "at": datetime.now().isoformat(timespec="seconds")}
            uploaded.append({"kind": t["kind"], "legacyId": t["legacyId"], "imageUrl": url})
            if n % 25 == 0:
                log.info(f"  {n}/{len(todo)} uploaded...")
                save_ledger(ledger)   # checkpoint, so a crash doesn't redo everything
        except Exception as e:
            failed += 1
            log.error(f"  upload failed for {t['filename']}: {e}")

    if not DRY_RUN:
        save_ledger(ledger)

    log.info(f"\nUploaded {len(uploaded)}, missing on disk {missing}, failed {failed}")
    if missing:
        log.warning(
            f"{missing} photos are named in the database but not in {IMAGE_ROOT}. "
            "Either they were never taken, or there is a second photo folder — "
            "worth asking the shop."
        )

    if uploaded and not DRY_RUN:
        for base in BACKENDS:
            log.info(f"Linking to {base} ...")
            try:
                token = login(base)
            except Exception as e:
                log.error(f"  login failed: {e}")
                continue
            push_images(token, base, uploaded)

    log.info("Photo sync complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log.warning("Interrupted — progress is saved; just run it again.")
        sys.exit(1)
