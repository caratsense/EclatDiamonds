"""
Eclat / CaratSense — CATALOGUE PHOTO SYNC

Uploads the shop's jewellery photographs to cloud storage and tells Eclat where
they landed, so the catalogue shows the real piece instead of a grey placeholder.

Flow, per image:
    SQL Server names the file  ->  find it on this PC  ->  upload to storage
    ->  POST {legacyId, imageUrl} to Eclat

Storage is Cloudflare R2 by default (set the R2_* values in eclat_config.bat).
Cloudinary is still supported for anyone already on it — whichever is configured
gets used, R2 first if both are.

The bytes go STRAIGHT from this PC to the storage provider — they never pass
through the Eclat backend. That matters: a jewellery catalogue is tens of GB of
camera JPEGs, and routing it through the API would be slow, would be billed as
egress twice, and would hit request-size limits. Eclat only receives the link.

Safe to re-run. An `uploaded_media.json` ledger records what has already gone up,
so a second run only does what is new. Delete that file to force a full re-upload.

Run:  sync_media.bat --folders   see which folders hold photos, and choose
      sync_media.bat 25          upload a small batch first
      sync_media.bat             upload the rest
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

# .strip() because this path routinely contains spaces ("SJEP IMAGES") and a
# stray trailing one from a hand-edited config would make the folder "missing".
IMAGE_ROOT = os.getenv("SJEP_IMAGE_ROOT", "").strip().strip('"')

# Cloudflare R2 (preferred)
R2_ACCOUNT = os.getenv("R2_ACCOUNT_ID", "")
R2_KEY     = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET  = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET  = os.getenv("R2_BUCKET", "")
R2_PUBLIC  = os.getenv("R2_PUBLIC_BASE_URL", "")

# Cloudinary (alternative)
CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME", "")
CLOUD_KEY  = os.getenv("CLOUDINARY_API_KEY", "")
CLOUD_SEC  = os.getenv("CLOUDINARY_API_SECRET", "")

HERE      = os.path.dirname(os.path.abspath(__file__))
LEDGER    = os.path.join(HERE, "uploaded_media.json")
LOG_DIR   = os.path.join(HERE, "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE  = os.path.join(LOG_DIR, "media_sync.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("eclat-media")

# The Windows console is cp1252 and turns any non-ASCII into "?", which reads
# as corruption in a log someone is watching on a call.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DRY_RUN = "--dry-run" in sys.argv
LIMIT = None
for i, a in enumerate(sys.argv):
    if a == "--limit" and i + 1 < len(sys.argv):
        LIMIT = int(sys.argv[i + 1])

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


def fail(msg):
    log.error(msg)
    sys.exit(1)


def storage_backend():
    """Pick the configured provider. R2 wins if both are set."""
    if all([R2_ACCOUNT, R2_KEY, R2_SECRET, R2_BUCKET, R2_PUBLIC]):
        from eclat_r2 import R2Client
        return "r2", R2Client(R2_ACCOUNT, R2_KEY, R2_SECRET, R2_BUCKET, R2_PUBLIC)
    if all([CLOUD_NAME, CLOUD_KEY, CLOUD_SEC]):
        return "cloudinary", None
    return None, None


def check_config():
    if not BACKENDS or not EMAIL or not PASSWORD:
        fail("Eclat settings missing. Run this through sync_media.bat so eclat_config.bat loads.")

    provider, client = storage_backend()
    if provider is None:
        # Name the partially-filled one, so the operator fixes the field they
        # meant to fill rather than re-reading the whole config.
        partial = ""
        if any([R2_ACCOUNT, R2_KEY, R2_SECRET, R2_BUCKET, R2_PUBLIC]):
            missing = [n for n, v in [
                ("R2_ACCOUNT_ID", R2_ACCOUNT), ("R2_ACCESS_KEY_ID", R2_KEY),
                ("R2_SECRET_ACCESS_KEY", R2_SECRET), ("R2_BUCKET", R2_BUCKET),
                ("R2_PUBLIC_BASE_URL", R2_PUBLIC)] if not v]
            # ASCII only: this prints to a cp1252 console, where an em-dash
            # arrives as a replacement character and looks like corruption.
            partial = "\nR2 is partly filled in - still missing: " + ", ".join(missing)
        fail(
            "No photo storage configured. Add your Cloudflare R2 details to "
            "eclat_config.bat:\n"
            "  set R2_ACCOUNT_ID=...          (Cloudflare dashboard -> R2 -> Overview)\n"
            "  set R2_ACCESS_KEY_ID=...       (R2 -> Manage API Tokens)\n"
            "  set R2_SECRET_ACCESS_KEY=...\n"
            "  set R2_BUCKET=...              (the bucket name you created)\n"
            "  set R2_PUBLIC_BASE_URL=...     (bucket -> Settings -> Public access)"
            + partial
        )

    if provider == "r2":
        ok, msg = client.check_access()
        if not ok:
            fail(msg)
        log.info(f"Storage: Cloudflare R2 bucket '{R2_BUCKET}' (access confirmed)")
    else:
        log.info(f"Storage: Cloudinary '{CLOUD_NAME}'")

    if not IMAGE_ROOT or not os.path.isdir(IMAGE_ROOT):
        fail(
            f"SJEP_IMAGE_ROOT is not set or does not exist ({IMAGE_ROOT!r}).\n"
            "Run discover.bat first — it hunts for the photo folder and prints the\n"
            "exact line to paste into eclat_config.bat."
        )

    return provider, client


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


def _folder_filters():
    """Which folders to take photos from, and which to leave alone.

    A jewellery photo library is not all photographs. Alongside the shots a
    customer should see there are technical images with the measurements printed
    across them — "18.5 mm", overall size, a description burnt into the picture.
    Those are for the workshop, not the shop floor, and putting them in a
    customer-facing catalogue is worse than having no photo at all.

    They cannot be told apart by filename or size, but they are almost always
    kept in their own folders, so the folder is the honest filter:

        set "SJEP_IMAGE_ONLY_FOLDERS=LIVE IMAGES"     take ONLY these
        set "SJEP_IMAGE_SKIP_FOLDERS=STL,MEASUREMENT" take everything except

    Matching is case-insensitive on any part of the path below the root, so
    "LIVE IMAGES" catches "SJEP IMAGES\\LIVE IMAGES\\rings". Use
    `sync_media.bat --folders` to list what is actually there before choosing.
    """
    only = [s.strip().lower() for s in os.getenv("SJEP_IMAGE_ONLY_FOLDERS", "").split(",") if s.strip()]
    skip = [s.strip().lower() for s in os.getenv("SJEP_IMAGE_SKIP_FOLDERS", "").split(",") if s.strip()]
    return only, skip


def _folder_allowed(rel_dir, only, skip):
    low = rel_dir.replace("\\", "/").lower()
    parts = [p for p in low.split("/") if p]
    if any(s in low or s in parts for s in skip):
        return False
    if only:
        return any(o in low or o in parts for o in only)
    return True


def list_image_folders(root):
    """Show every folder holding images, so a human can choose. Uploads nothing."""
    log.info(f"Photo folders under {root}:\n")
    per = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        imgs = [f for f in filenames if os.path.splitext(f)[1].lower() in IMAGE_EXTS]
        if imgs:
            rel = os.path.relpath(dirpath, root)
            per[rel] = (len(imgs), sorted(imgs)[:3])
    if not per:
        log.info("  (no images found)")
        return
    for rel, (n, sample) in sorted(per.items(), key=lambda kv: -kv[1][0]):
        log.info(f"  {rel:<44} {n:>6} images")
        log.info(f"      e.g. {', '.join(sample)}")
    log.info("")
    log.info("  Open a few from each folder and look at them. Any folder whose")
    log.info("  pictures have measurements or descriptions printed ON the image")
    log.info("  should NOT go in the catalogue. Then set one of these in")
    log.info("  eclat_config.bat:")
    log.info('    set "SJEP_IMAGE_ONLY_FOLDERS=LIVE IMAGES"    (take only these)')
    log.info('    set "SJEP_IMAGE_SKIP_FOLDERS=STL,SIZE"       (skip these)')


def build_file_index(root):
    """One walk of the photo folder -> {lowercase filename: full path}.

    Indexing up front beats searching per image: a catalogue has thousands of
    rows and the folder is often on a slow or network disk, so one pass is the
    difference between minutes and hours.
    """
    only, skip = _folder_filters()
    if only:
        log.info(f"Indexing photos under {root} — ONLY folders matching: {', '.join(only)}")
    elif skip:
        log.info(f"Indexing photos under {root} — skipping folders matching: {', '.join(skip)}")
    else:
        log.info(f"Indexing photos under {root} ...")

    index = {}
    count = 0
    skipped = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        rel = os.path.relpath(dirpath, root)
        allowed = _folder_allowed("" if rel == "." else rel, only, skip)
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() not in IMAGE_EXTS:
                continue
            if not allowed:
                skipped += 1
                continue
            # First match wins, so a folder listed earlier in ONLY_FOLDERS takes
            # precedence when the same filename exists in several places.
            index.setdefault(fn.lower(), os.path.join(dirpath, fn))
            count += 1
    log.info(f"  indexed {count} image files ({len(index)} distinct names)")
    if skipped:
        log.info(f"  skipped {skipped} image(s) in excluded folders")
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

    if "--folders" in sys.argv:
        if not IMAGE_ROOT or not os.path.isdir(IMAGE_ROOT):
            fail(f"SJEP_IMAGE_ROOT is not set or does not exist ({IMAGE_ROOT!r}).")
        list_image_folders(IMAGE_ROOT)
        return 0

    provider, client = check_config()

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
            if provider == "r2":
                # Keep the real extension so R2 serves the right Content-Type and
                # the URL is recognisable when someone opens the bucket.
                ext = os.path.splitext(path)[1].lower() or ".jpg"
                url = client.upload_file(path, f"catalogue/{public_id}{ext}")
            else:
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
