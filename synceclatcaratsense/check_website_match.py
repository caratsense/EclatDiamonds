"""
Eclat / CaratSense — DO THE WEBSITE AND THE SHOP SYSTEM AGREE? (read-only)

The shop's system (Gati) knows what each design IS and where the pieces are.
The website knows what it LOOKS like and what it COSTS. To show one catalogue we
have to join them, and the join is the design code.

This measures whether that actually works, against the LIVE database:

    Gati     StyleMst.StyleCode    09987RG-050
    Website  productCode           09987RG-050

If most codes line up, the catalogue is a straight import. If they do not, every
design has to be matched by hand — hundreds of them — and that is worth knowing
before anyone promises a date.

Reads the database read-only and fetches the public website. Changes nothing,
uploads nothing.

Run:  check_website_match.bat
"""
import os
import re
import sys
import json
from datetime import datetime

import requests

SQL_SERVER = os.getenv("SJEP_SQL_SERVER", r"localhost\SQLEXPRESS")
SQL_DB     = os.getenv("SJEP_SQL_DB", "APRSSJEP")
SQL_USER   = os.getenv("SJEP_SQL_USER", "")
SQL_PASS   = os.getenv("SJEP_SQL_PASS", "")

WEBSITE_API = os.getenv(
    "ECLAT_WEBSITE_API",
    "https://apis.eclatdiamonds.in/v1/api/products/customer?page=1&limit=2000",
)

HERE = os.path.dirname(os.path.abspath(__file__))
REPORT_DIR = os.path.join(HERE, "reports")
os.makedirs(REPORT_DIR, exist_ok=True)
REPORT = os.path.join(REPORT_DIR, "website_match.txt")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

_lines = []
def out(s=""):
    print(s)
    _lines.append(str(s))


def save():
    try:
        with open(REPORT, "w", encoding="utf-8") as f:
            f.write("\n".join(_lines))
        print(f"\n(report saved to {REPORT})")
    except Exception as e:
        print(f"\n(could not save: {e})")


def base(code):
    """Drop a trailing -050 / -100 size suffix.

    The website lists the same design once per carat weight (09987RG-050 and
    09987RG-100), while the shop system may carry only the base design. Matching
    both ways shows whether a miss is a genuinely absent design or just a
    different size of one we already have.
    """
    return re.sub(r"-\d+$", "", (code or "").strip()).upper()


def gati_codes():
    import pyodbc
    drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
    if not drivers:
        out("[STOP] No SQL Server ODBC driver installed.")
        return None
    auth = f"UID={SQL_USER};PWD={SQL_PASS};" if SQL_USER else "Trusted_Connection=yes;"
    cs = (f"DRIVER={{{drivers[-1]}}};SERVER={SQL_SERVER};DATABASE={SQL_DB};{auth}"
          "ApplicationIntent=ReadOnly;TrustServerCertificate=yes;")
    conn = pyodbc.connect(cs, readonly=True, timeout=30)
    cur = conn.cursor()
    cur.execute("SELECT StyleCode FROM StyleMst WHERE StyleCode IS NOT NULL "
                "AND LTRIM(RTRIM(StyleCode)) <> ''")
    codes = [str(r[0]).strip() for r in cur.fetchall()]
    conn.close()
    return codes


def website_products():
    r = requests.get(
        WEBSITE_API,
        headers={"User-Agent": "Mozilla/5.0",
                 "Origin": "https://eclatdiamonds.in",
                 "Referer": "https://eclatdiamonds.in/"},
        timeout=90,
    )
    r.raise_for_status()
    d = r.json()
    if isinstance(d, list):
        return d
    data = d.get("data") or {}
    if isinstance(data, list):
        return data
    return data.get("products") or data.get("docs") or []


def main():
    out("=" * 74)
    out("DOES THE WEBSITE MATCH THE SHOP SYSTEM? (read-only)")
    out(f"run at   : {datetime.now().isoformat(timespec='seconds')}")
    out(f"database : {SQL_SERVER} / {SQL_DB}")
    out("=" * 74)

    try:
        codes = gati_codes()
    except Exception as e:
        out(f"\n[STOP] Could not read the database: {str(e)[:200]}")
        out("       Run 1_discover.bat first — it works out the right settings.")
        save()
        return 1
    if codes is None:
        save()
        return 1
    out(f"\n  Designs in the shop system : {len(codes):,}")

    try:
        prods = website_products()
    except Exception as e:
        out(f"\n[STOP] Could not read the website: {str(e)[:200]}")
        out("       This computer may have no internet, or a proxy is blocking it.")
        save()
        return 1
    web = [p for p in prods if p.get("productCode")]
    out(f"  Designs on the website     : {len(web):,}")
    if not web or not codes:
        out("\n  Nothing to compare.")
        save()
        return 1

    gati_exact = {c.strip().upper() for c in codes}
    gati_base = {base(c) for c in codes}

    exact = [p for p in web if p["productCode"].strip().upper() in gati_exact]
    loose = [p for p in web
             if p["productCode"].strip().upper() not in gati_exact
             and base(p["productCode"]) in gati_base]
    missing = [p for p in web
               if p["productCode"].strip().upper() not in gati_exact
               and base(p["productCode"]) not in gati_base]

    pct = len(exact) * 100 // len(web)
    matched_codes = {p["productCode"].strip().upper() for p in exact}
    shop_only = len({c.strip().upper() for c in codes} - matched_codes)

    out("")
    out("-" * 74)
    out("  THE THREE BUCKETS")
    out("-" * 74)
    out(f"    on BOTH — website price fits an existing design   {len(exact):>5}"
        f"  ({pct}% of the website)")
    out(f"    same design, other size                          {len(loose):>5}")
    out(f"    WEBSITE ONLY — not a design the shop has held    {len(missing):>5}")
    out(f"    SHOP ONLY — held in store, not sold online       {shop_only:>5}")
    out(f"    catalogue would therefore carry                  "
        f"{len(codes) + len(missing):>5} designs")

    out("")
    # Deliberately not a pass/fail grade. "Website only" is not a defect for a
    # jeweller — it is the showroom-vs-online split, and it is exactly what the
    # request-to-head-office flow exists to serve. The only genuinely bad case
    # is NO overlap, which would mean the two systems number their designs
    # independently and nothing can be joined without a person deciding.
    if len(exact) + len(loose) == 0:
        out("  >> NOTHING JOINS. The two systems appear to number their designs")
        out("     independently, so no website price can be attached to a design")
        out("     in the shop system with any confidence. Joining them would be a")
        out("     manual exercise — raise this before committing to a date.")
    else:
        out("  >> USABLE. The codes are shared, so the overlap is real and not a")
        out("     coincidence; the website's price and description can be attached")
        out("     to those designs directly.")
        out("")
        out("     The rest is NOT a problem to be fixed. It is the split every")
        out("     jeweller has:")
        out(f"       - the {len(missing)} website-only designs become catalogue entries a")
        out("         salesperson can show and then RAISE A REQUEST for — visible,")
        out("         priced, honestly marked as not in stock;")
        out(f"       - the {shop_only} shop-only designs are what the branches actually")
        out("         hold, priced from the stock record rather than the website.")
        out("")
        out("     Worth asking the client once: is the website meant to mirror the")
        out("     shop, or is it a separate online range? The answer changes")
        out("     nothing technically — it changes what staff should be told.")

    if missing:
        out("")
        out("  On the website but NOT in the shop system (first 25):")
        for p in missing[:25]:
            price = p.get("indicativePrice") or p.get("minVariantPrice") or ""
            out(f"    {p['productCode']:<22} {str(p.get('name',''))[:38]:<40} {price}")
        if len(missing) > 25:
            out(f"    ... and {len(missing) - 25} more")

    # What the website adds that the shop system does not have.
    priced = [p for p in web if p.get("indicativePrice") or p.get("minVariantPrice")]
    out("")
    out("-" * 74)
    out("  WHAT THE WEBSITE ADDS")
    out("-" * 74)
    out(f"    designs with a price       {len(priced):>5} / {len(web)}")
    cats = {}
    for p in web:
        for c in (p.get("category") or []):
            n = c.get("name") if isinstance(c, dict) else str(c)
            cats[n] = cats.get(n, 0) + 1
    if cats:
        out("    categories:")
        for n, c in sorted(cats.items(), key=lambda kv: -kv[1])[:12]:
            out(f"      {n:<28} {c}")

    sample = exact[0] if exact else web[0]
    out("")
    out("  Example of what would be imported:")
    out(f"    code   {sample.get('productCode')}")
    out(f"    name   {sample.get('name')}")
    out(f"    price  {sample.get('indicativePrice') or sample.get('minVariantPrice')} "
        f"{sample.get('currency','')}")
    out(f"    slug   {sample.get('slug')}")

    out("\n" + "=" * 74)
    out("DONE — nothing was changed, nothing was uploaded.")
    out(f"Send this file to the Eclat team: {REPORT}")
    out("=" * 74)
    save()
    return 0


if __name__ == "__main__":
    sys.exit(main())
