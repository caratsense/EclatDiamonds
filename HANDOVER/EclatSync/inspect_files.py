"""
Eclat / CaratSense — FILE INSPECTION (read-only, changes nothing)

The database says what the shop RECORDS. This says what they actually HAVE on
disk, which is a different question and often a more awkward one:

  * The catalogue names 4,681 photographs. How many exist as files?
  * How big are those files? R2 serves exactly what is uploaded — no resizing —
    so 8 MB camera originals mean a catalogue that crawls on shop wifi, and a
    storage bill to match. Better known before the upload than after.
  * What else is in there — backups, database files, report templates, label
    formats? Each one is either something to bring across or something to
    deliberately leave behind, and both need a decision.

Reads only. Opens no file's contents except to measure it. Uploads nothing.

Run:  inspect_files.bat        (or: python inspect_files.py [folder])
"""
import os
import sys
from collections import defaultdict
from datetime import datetime

ROOT = os.getenv("SJEP_ROOT", r"D:\GATISOFTTECH")
HERE = os.path.dirname(os.path.abspath(__file__))
REPORT_DIR = os.path.join(HERE, "reports")
os.makedirs(REPORT_DIR, exist_ok=True)
REPORT = os.path.join(REPORT_DIR, "file_inventory.txt")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

_lines = []
def out(s=""):
    print(s)
    _lines.append(str(s))


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:,.0f} {unit}" if unit == "B" else f"{n:,.1f} {unit}"
        n /= 1024.0


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

# What each kind of file means for the migration. The point of the report is not
# "here are some files" but "here is what to do about them".
MEANING = {
    ".bak":  "SQL Server BACKUP — a copy of a database, not live data",
    ".mdf":  "SQL Server DATA FILE — this IS a live database. Never copy or move it.",
    ".ldf":  "SQL Server LOG FILE — belongs with the .mdf above",
    ".repx": "DevExpress REPORT TEMPLATE — a printed form they use today",
    ".btw":  "BarTender LABEL format — tag/barcode printing",
    ".pdk":  "Application package/licence file",
    ".stl":  "3D model (for casting) — not a photograph",
    ".exe":  "Installer / program",
    ".msi":  "Installer",
    ".config": "Program settings — MAY CONTAIN A DATABASE PASSWORD",
    ".ini":  "Program settings — MAY CONTAIN A DATABASE PASSWORD",
    ".udl":  "Database connection file — CONTAINS CONNECTION DETAILS",
    ".xml":  "Settings or data export",
    ".pdf":  "Document",
    ".xlsx": "Spreadsheet",
    ".xls":  "Spreadsheet",
    ".csv":  "Spreadsheet / data export",
    ".zip":  "Archive",
    ".rar":  "Archive",
    ".log":  "Program log",
}


def walk(root):
    """(files, unreadable) — every file under root with its size and date."""
    files, denied = [], []
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: denied.append(str(e))):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
                files.append((full, st.st_size, st.st_mtime))
            except Exception:
                denied.append(full)
    return files, denied


def main():
    out("=" * 74)
    out("ECLAT / CARATSENSE — WHAT IS ACTUALLY IN THIS FOLDER (read-only)")
    out(f"run at : {datetime.now().isoformat(timespec='seconds')}")
    out(f"folder : {ROOT}")
    out("=" * 74)

    if not os.path.isdir(ROOT):
        out(f"\n[STOP] That folder does not exist on this computer.")
        out("       Run it against the right one, e.g.:")
        out("         inspect_files.bat D:\\GATISOFTTECH")
        save()
        return 1

    out("\nReading the folder... (large folders take a minute)")
    files, denied = walk(ROOT)
    if not files:
        out("\n[STOP] No files found — or no permission to read them.")
        save()
        return 1

    total_bytes = sum(f[1] for f in files)
    out(f"\n  {len(files):,} files, {human(total_bytes)} in total")
    if denied:
        out(f"  ({len(denied)} item(s) could not be read — permissions)")

    # ── Top-level folders: where the weight is ────────────────────────────────
    out("\n" + "-" * 74)
    out("1. THE FOLDERS")
    out("-" * 74)
    per_dir = defaultdict(lambda: [0, 0])   # name -> [count, bytes]
    for full, size, _ in files:
        rel = os.path.relpath(full, ROOT)
        top = rel.split(os.sep)[0] if os.sep in rel else "(loose files)"
        per_dir[top][0] += 1
        per_dir[top][1] += size
    for name, (n, b) in sorted(per_dir.items(), key=lambda kv: -kv[1][1]):
        out(f"  {name:<34} {n:>7,} files   {human(b):>12}")

    # ── By file type, with what each one means ────────────────────────────────
    out("\n" + "-" * 74)
    out("2. WHAT KIND OF FILES, AND WHAT THEY MEAN")
    out("-" * 74)
    per_ext = defaultdict(lambda: [0, 0, None])   # ext -> [count, bytes, newest]
    for full, size, mtime in files:
        ext = os.path.splitext(full)[1].lower()
        e = per_ext[ext]
        e[0] += 1
        e[1] += size
        if e[2] is None or mtime > e[2]:
            e[2] = mtime
    for ext, (n, b, newest) in sorted(per_ext.items(), key=lambda kv: -kv[1][1])[:25]:
        when = datetime.fromtimestamp(newest).strftime("%Y-%m-%d") if newest else "?"
        label = MEANING.get(ext, "")
        out(f"  {ext or '(none)':<8} {n:>7,} files  {human(b):>11}  newest {when}"
            + (f"\n           {label}" if label else ""))

    # ── Photographs: the section that changes decisions ───────────────────────
    photos = [(f, s, m) for f, s, m in files
              if os.path.splitext(f)[1].lower() in IMAGE_EXTS]
    out("\n" + "-" * 74)
    out("3. PHOTOGRAPHS — the ones that would go to the catalogue")
    out("-" * 74)
    if not photos:
        out("  None found under this folder.")
    else:
        pbytes = sum(p[1] for p in photos)
        avg = pbytes / len(photos)
        out(f"  {len(photos):,} images, {human(pbytes)} in total, average {human(avg)}")
        out("")
        # Size bands. This is the number that decides whether the catalogue is
        # usable on a phone, because R2 serves the original bytes unchanged.
        bands = [(0, 200*1024, "under 200 KB   (ideal)"),
                 (200*1024, 1024*1024, "200 KB - 1 MB  (fine)"),
                 (1024*1024, 3*1024*1024, "1 - 3 MB       (heavy)"),
                 (3*1024*1024, 8*1024*1024, "3 - 8 MB       (too big for a grid)"),
                 (8*1024*1024, float("inf"), "over 8 MB      (camera originals)")]
        for lo, hi, label in bands:
            n = sum(1 for p in photos if lo <= p[1] < hi)
            if n:
                pct = n * 100 // len(photos)
                out(f"    {label:<36} {n:>7,}  ({pct}%)")
        big = sum(1 for p in photos if p[1] > 1024 * 1024)
        out("")
        if big > len(photos) // 4:
            out(f"  >> {big:,} images are over 1 MB. R2 does NOT resize — a phone")
            out("     downloads the full file to draw a thumbnail. Expect a slow")
            out("     catalogue on shop wifi, and plan to shrink them on upload or")
            out("     put Cloudflare Images in front.")
        else:
            out("  >> Sizes are reasonable; the catalogue should load comfortably.")
        out("")
        out(f"  Estimated storage: {human(pbytes)}  "
            f"(R2 free tier is 10 GB, then about $0.015/GB/month)")

        # Where they live, so nobody has to guess the folder again.
        out("\n  Which folders hold them:")
        per_photo_dir = defaultdict(lambda: [0, 0])
        for f, s, _ in photos:
            d = os.path.relpath(os.path.dirname(f), ROOT)
            per_photo_dir[d][0] += 1
            per_photo_dir[d][1] += s
        for d, (n, b) in sorted(per_photo_dir.items(), key=lambda kv: -kv[1][0])[:15]:
            out(f"    {d:<40} {n:>7,} images  {human(b):>11}")
        if len(per_photo_dir) > 15:
            out(f"    ... and {len(per_photo_dir) - 15} more folders")

        common = os.path.commonpath([os.path.dirname(f) for f, _, _ in photos]) \
            if len(photos) > 1 else os.path.dirname(photos[0][0])
        out("")
        out("  SETTING TO USE (paste into eclat_config.bat):")
        out(f'    set "SJEP_IMAGE_ROOT={common}"')

    # ── Backups and live database files ───────────────────────────────────────
    out("\n" + "-" * 74)
    out("4. BACKUPS AND DATABASE FILES")
    out("-" * 74)
    dbfiles = [(f, s, m) for f, s, m in files
               if os.path.splitext(f)[1].lower() in (".bak", ".mdf", ".ldf")]
    if not dbfiles:
        out("  None here.")
    else:
        for f, s, m in sorted(dbfiles, key=lambda x: -x[2])[:25]:
            when = datetime.fromtimestamp(m).strftime("%Y-%m-%d %H:%M")
            out(f"  {when}  {human(s):>11}  {os.path.relpath(f, ROOT)}")
        # Age is measured on BACKUPS only. The .mdf/.ldf are the live database
        # and are touched constantly, so including them always reports "0 days"
        # and the stale-backup warning could never fire — which is exactly the
        # warning worth having.
        baks = [d for d in dbfiles if d[0].lower().endswith(".bak")]
        out("")
        if not baks:
            out("  >> No .bak backup files here at all. Ask where their backups go —")
            out("     if the answer is 'nowhere', that is worth saying out loud")
            out("     before anyone touches this system.")
            age = None
        else:
            newest = max(baks, key=lambda x: x[2])
            age = (datetime.now() - datetime.fromtimestamp(newest[2])).days
            out(f"  Most recent BACKUP: {os.path.basename(newest[0])} — {age} day(s) old")
        if age is not None and age > 7:
            out("  >> No recent backup. Worth mentioning to the client: this is their")
            out("     safety net, and it is stale. Not our problem to fix, but they")
            out("     should know before anyone touches anything.")

    # ── Anything that may hold a password ─────────────────────────────────────
    out("\n" + "-" * 74)
    out("5. FILES THAT MAY CONTAIN CONNECTION DETAILS")
    out("-" * 74)
    out("  Listed so YOU know they exist, not to open them. If a database")
    out("  password is sitting in a plain text file, the client should know.")
    out("")
    secrets = [(f, s) for f, s, _ in files
               if os.path.splitext(f)[1].lower() in (".config", ".ini", ".udl")]
    if not secrets:
        out("  None found.")
    else:
        for f, s in secrets[:20]:
            out(f"  {human(s):>10}  {os.path.relpath(f, ROOT)}")
        if len(secrets) > 20:
            out(f"  ... and {len(secrets) - 20} more")

    # ── Report templates: what they print today ───────────────────────────────
    out("\n" + "-" * 74)
    out("6. PRINTED FORMS THEY USE TODAY")
    out("-" * 74)
    reports = [f for f, _, _ in files if os.path.splitext(f)[1].lower() in (".repx", ".btw")]
    if not reports:
        out("  None found.")
    else:
        out(f"  {len(reports)} template(s). These are the invoices, tags and")
        out("  certificates the shop prints now — Eclat has to match them or")
        out("  the staff will keep using the old system.")
        out("")
        for f in sorted(reports)[:40]:
            out(f"    {os.path.relpath(f, ROOT)}")
        if len(reports) > 40:
            out(f"    ... and {len(reports) - 40} more")

    out("\n" + "=" * 74)
    out("DONE — nothing was changed, nothing was uploaded.")
    out(f"Send this file to the Eclat team: {REPORT}")
    out("=" * 74)
    save()
    return 0


def save():
    try:
        with open(REPORT, "w", encoding="utf-8") as f:
            f.write("\n".join(_lines))
        print(f"\n(report saved to {REPORT})")
    except Exception as e:
        print(f"\n(could not save the report: {e})")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        ROOT = sys.argv[1]
    sys.exit(main())
