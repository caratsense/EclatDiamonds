"""
Eclat / CaratSense — bring the WEBSITE designs into the catalogue.

Why this exists rather than using the shop's own picture folder:

  The pictures in D:\\GATISOFTTECH\\SJEP IMAGES are the WORKING library. A large
  share of them have the measurements and specification printed across the
  image — right for the workshop, wrong for a customer. Someone shown "18.5 mm"
  written over a ring learns nothing from it and trusts the shop slightly less.

  The website already carries the retouched shots the client publishes, and
  those files are already on a public CDN. So this uploads NOTHING: it reads the
  same product feed the website itself uses and hands Eclat the URL.

It also brings a price. Gati fills `StyleMstSummary.MRP` on under half the
designs, while every website design has one.

Two kinds of design come across:
  * one whose code matches a design already synced from Gati — that design is
    only ENRICHED (photo, and price if it had none). Nothing Gati supplied is
    overwritten; Gati is the authority on anything it actually holds.
  * one that matches nothing — created as made-to-order, company-wide. The shop
    sells it, no branch has one, and a salesperson can raise it to head office.

Read-only against the website. Touches SQL Server not at all.

Run:  import_website.bat            see what would happen, send nothing
      import_website.bat --send     do it
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WEBSITE_API = os.getenv(
    "ECLAT_WEBSITE_API",
    "https://apis.eclatdiamonds.in/v1/api/products/customer?page=1&limit=2000",
)
BASE_URL = (os.getenv("ECLAT_BASE_URL") or "").strip().rstrip("/")
EMAIL = (os.getenv("ECLAT_EMAIL") or "").strip()
PASSWORD = (os.getenv("ECLAT_PASSWORD") or "").strip()
CHUNK = 200

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def fetch_products():
    req = urllib.request.Request(
        WEBSITE_API,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://eclatdiamonds.in",
            "Referer": "https://eclatdiamonds.in/",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode())
    for key in ("data", "products", "items", "result"):
        if isinstance(d, dict) and key in d:
            d = d[key]
            break
    if isinstance(d, dict):
        d = d.get("products") or next(iter(d.values()))
    return d if isinstance(d, list) else []


def first_image(p):
    """The first real photograph on any colour variant.

    Products are shaped variantType[] -> shapes[] -> images[], and a shape can
    carry an empty list, so this walks until it finds something rather than
    trusting position 0.
    """
    for v in p.get("variantType") or []:
        for s in v.get("shapes") or []:
            for img in s.get("images") or []:
                if isinstance(img, str) and img.startswith("http"):
                    return img
        for img in v.get("images") or []:
            if isinstance(img, str) and img.startswith("http"):
                return img
    return None


def names(v):
    """category/subCategory arrive as [{name: ...}]; flatten to plain text."""
    if isinstance(v, list):
        return " ".join(str(x.get("name") if isinstance(x, dict) else x) for x in v)
    return str(v or "")


def karat_of(p):
    for v in p.get("variants") or []:
        k = str(v.get("karat") or "").strip()
        if k.isdigit():
            return int(k)
    return 0


def carat_of(p):
    for v in p.get("variants") or []:
        for key in ("diamondWeight", "caratWeight", "totalCaratWeight"):
            try:
                c = float(v.get(key))
                if c > 0:
                    return c
            except (TypeError, ValueError):
                pass
    return 0


def to_record(p):
    return {
        "productCode": (p.get("productCode") or "").strip(),
        "name": (p.get("name") or "").strip(),
        "category": f"{names(p.get('category'))} {names(p.get('subCategory'))}".strip(),
        "price": p.get("indicativePrice") or p.get("minVariantPrice") or 0,
        "karat": karat_of(p),
        "caratWeight": carat_of(p),
        "description": (p.get("description") or "").strip() or None,
        "imageUrl": first_image(p),
    }


def login():
    body = json.dumps({"email": EMAIL, "password": PASSWORD}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/auth/login", data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())["token"]


def push(token, records):
    created = enriched = skipped = 0
    for i in range(0, len(records), CHUNK):
        batch = records[i:i + CHUNK]
        body = json.dumps({"records": batch}).encode()
        req = urllib.request.Request(
            f"{BASE_URL}/sync/website-products", data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=300) as r:
            res = json.loads(r.read().decode())
        created += res.get("created", 0)
        enriched += res.get("enriched", 0)
        skipped += res.get("skipped", 0)
        print(f"    sent {i + len(batch)}/{len(records)}  "
              f"created={created} enriched={enriched} skipped={skipped}")
    return created, enriched, skipped


def main():
    send = "--send" in sys.argv
    print("=" * 72)
    print("  WEBSITE DESIGNS -> ECLAT CATALOGUE")
    print("  " + ("SENDING" if send else "PREVIEW — nothing will be sent"))
    print("=" * 72)

    try:
        products = fetch_products()
    except Exception as e:
        print(f"\n[STOP] Could not read the website: {str(e)[:200]}")
        print("       No internet on this machine, or a proxy is blocking it.")
        return 1
    print(f"\n  designs on the website : {len(products):,}")

    records = [to_record(p) for p in products]
    records = [r for r in records if r["productCode"]]
    with_img = sum(1 for r in records if r["imageUrl"])
    with_price = sum(1 for r in records if r["price"])
    print(f"  usable (have a code)   : {len(records):,}")
    print(f"  with a photograph      : {with_img:,}")
    print(f"  with a price           : {with_price:,}")

    if not records:
        print("\n  Nothing to import.")
        return 1

    print("\n  first three:")
    for r in records[:3]:
        print(f"    {r['productCode']:<16} {r['name'][:34]:<36} "
              f"{str(r['price']):>9}  {'photo' if r['imageUrl'] else 'NO PHOTO'}")

    if not send:
        print("\n" + "=" * 72)
        print("  Nothing was sent. To do it for real:")
        print("     import_website.bat --send")
        print("=" * 72)
        return 0

    if not BASE_URL or not EMAIL or not PASSWORD:
        print("\n[STOP] Eclat login missing — run 2_configure.bat first.")
        return 1

    print("\n  signing in...")
    try:
        token = login()
    except Exception as e:
        print(f"[STOP] Could not sign in to Eclat: {str(e)[:200]}")
        return 1

    created, enriched, skipped = push(token, records)
    print("\n" + "=" * 72)
    print(f"  DONE. {created} new design(s) added, {enriched} existing one(s) "
          f"given a photo/price, {skipped} unchanged.")
    print("  Photographs are served from the website's own CDN — nothing was")
    print("  uploaded, and nothing in the shop system was touched.")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Stopped by you (Ctrl+C). Nothing is broken.")
        sys.exit(0)
