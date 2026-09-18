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
import itertools
import json
import os
import sys
import urllib.request

from gati_machine_auth import approved_connection
from gati_runtime import GatiRunAlreadyActive, install_run_lock
from gati_target_safety import (
    require_approved_backend,
    require_approved_website,
)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WEBSITE_API = (os.getenv("ECLAT_WEBSITE_API") or "").strip()
APPROVED_WEBSITE_API = (os.getenv("ECLAT_APPROVED_WEBSITE_API") or "").strip()
WEBSITE_ORIGIN = (os.getenv("ECLAT_WEBSITE_ORIGIN") or "").strip()
BASE_URL = (os.getenv("ECLAT_BASE_URL") or "").strip().rstrip("/")
APPROVED_BACKEND = (os.getenv("CARATOS_APPROVED_BACKEND_ORIGIN") or "").strip()
AGENT_TOKEN = (os.getenv("CARATOS_AGENT_TOKEN") or "").strip()
SQL_SERVER = (os.getenv("SJEP_SQL_SERVER") or r"localhost\SQLEXPRESS").strip()
SQL_DB = (os.getenv("SJEP_SQL_DB") or "APRSSJEP").strip()
APPROVAL_HEADERS = {}
HEARTBEAT = None
CHUNK = 200


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def fetch_products():
    endpoint, public_origin = require_approved_website(
        WEBSITE_API, APPROVED_WEBSITE_API, WEBSITE_ORIGIN
    )
    req = urllib.request.Request(
        endpoint,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Origin": public_origin,
            "Referer": f"{public_origin}/",
        },
    )
    # A configured feed cannot redirect this one-click command to an unreviewed
    # host. Review and pin the final endpoint instead.
    with NO_REDIRECT_OPENER.open(req, timeout=90) as r:
        d = json.loads(r.read().decode())
    for key in ("data", "products", "items", "result"):
        if isinstance(d, dict) and key in d:
            d = d[key]
            break
    if isinstance(d, dict):
        d = d.get("products") or next(iter(d.values()))
    return d if isinstance(d, list) else []


def all_images(p, limit=12):
    """Every real photograph on the product, without repeats, metals interleaved.

    Products are shaped variantType[] -> shapes[] -> images[], and a shape can
    carry an empty list, so this walks the whole structure rather than trusting
    position 0.

    This used to return the FIRST one and stop. That quietly threw away most of
    what the client had already photographed: a ring shot from four sides
    reached the catalogue as a single view, and because visual search matches
    against indexed pictures, it could only ever be found from that one view.
    The rest were sitting on the website CDN the whole time, costing nothing.

    Interleaved because the feed lists every rose-gold angle, then every
    white-gold one, then yellow. Cut in feed order, a design shot five ways per
    metal lost yellow gold entirely, and a customer's yellow piece had only other
    metals to match against. Round-robin keeps each metal's front and
    three-quarter view before any metal's fourth angle.

    Capped because every photo is embedded along with the jewellery detected in
    it, and each of those is an index row: twelve is four angles in three metals,
    which covers all but a handful of designs.
    """
    per_metal = []
    for v in p.get("variantType") or []:
        imgs = [img for s in v.get("shapes") or [] for img in s.get("images") or []]
        per_metal.append(imgs + list(v.get("images") or []))
    out = []
    for row in itertools.zip_longest(*per_metal):
        for img in row:
            if isinstance(img, str) and img.startswith("http") and img not in out:
                out.append(img)
    return out[:limit]


def first_image(p):
    """The cover: the first real photograph, or None when there is none."""
    imgs = all_images(p, limit=1)
    return imgs[0] if imgs else None


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
        # Every published shot, so the design is searchable from more than the
        # one angle that happened to be first in the feed.
        "imageUrls": all_images(p),
    }


def login():
    global BASE_URL, HEARTBEAT
    BASE_URL = require_approved_backend(BASE_URL, APPROVED_BACKEND)
    headers, HEARTBEAT = approved_connection(
        BASE_URL, AGENT_TOKEN, SQL_SERVER, SQL_DB
    )
    APPROVAL_HEADERS.clear()
    APPROVAL_HEADERS.update(headers)
    return AGENT_TOKEN


def heartbeat(phase, **stats):
    if HEARTBEAT is not None:
        HEARTBEAT.periodic({"phase": phase, **stats})


def terminal_heartbeat(ok, error=None, **stats):
    if HEARTBEAT is None:
        return False
    try:
        payload = {"phase": "complete" if ok else "failed", **stats}
        if ok:
            HEARTBEAT.success(payload)
        else:
            HEARTBEAT.error(error or "Website catalogue import failed", payload)
        return True
    except Exception:
        print("[WARN] Could not report terminal agent status.")
        return False


def _validated_acknowledgement(value, expected):
    if not isinstance(value, dict) or value.get("entity") != "website-products":
        raise RuntimeError("website import returned an invalid acknowledgement")
    counts = {
        name: value.get(name)
        for name in ("received", "upserted", "skipped", "created", "enriched")
    }
    if any(type(number) is not int or number < 0 for number in counts.values()):
        raise RuntimeError("website import returned invalid acknowledgement counts")
    if (
        counts["received"] != expected
        or counts["upserted"] + counts["skipped"] != expected
        or counts["created"] + counts["enriched"] != counts["upserted"]
    ):
        raise RuntimeError("website import acknowledgement did not cover the sent batch")
    return value


def push(token, records):
    created = enriched = skipped = 0
    for i in range(0, len(records), CHUNK):
        batch = records[i:i + CHUNK]
        heartbeat(
            "uploading",
            entity="website-products",
            rowsRead=i,
            rowsReady=len(records),
        )
        body = json.dumps({"records": batch}).encode()
        req = urllib.request.Request(
            f"{BASE_URL}/sync/website-products", data=body,
            headers=dict(APPROVAL_HEADERS))
        # Never forward the restricted machine bearer through an HTTP redirect.
        with NO_REDIRECT_OPENER.open(req, timeout=300) as r:
            res = _validated_acknowledgement(
                json.loads(r.read().decode()), len(batch)
            )
        created += res.get("created", 0)
        enriched += res.get("enriched", 0)
        skipped += res.get("skipped", 0)
        print(f"    sent {i + len(batch)}/{len(records)}  "
              f"created={created} enriched={enriched} skipped={skipped}")
    return created, enriched, skipped


def _main():
    send = "--send" in sys.argv
    print("=" * 72)
    print("  WEBSITE DESIGNS -> ECLAT CATALOGUE")
    print("  " + ("SENDING" if send else "PREVIEW — nothing will be sent"))
    print("=" * 72)

    if send:
        if not BASE_URL or not AGENT_TOKEN:
            print("\n[STOP] Restricted Gati agent token missing — run 2_configure.bat first.")
            return 1
        print("\n  validating restricted Gati agent approval...")
        try:
            login()
        except Exception as e:
            print(f"[STOP] Gati agent approval failed: {str(e)[:200]}")
            return 1

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
    total_img = sum(len(r.get("imageUrls") or []) for r in records)
    with_price = sum(1 for r in records if r["price"])
    print(f"  usable (have a code)   : {len(records):,}")
    print(f"  with a photograph      : {with_img:,}")
    print(f"  photographs in total   : {total_img:,}  (every angle, not just the cover)")
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

    created, enriched, skipped = push(AGENT_TOKEN, records)
    print("\n" + "=" * 72)
    print(f"  DONE. {created} new design(s) added, {enriched} existing one(s) "
          f"given a photo/price, {skipped} unchanged.")
    print("  Photographs are served from the website's own CDN — nothing was")
    print("  uploaded, and nothing in the shop system was touched.")
    print("=" * 72)
    return 0


def main():
    global HEARTBEAT
    HEARTBEAT = None
    APPROVAL_HEADERS.clear()
    try:
        result = _main()
    except Exception as exc:
        print(f"[STOP] Website catalogue import failed: {str(exc)[:200]}")
        terminal_heartbeat(False, exc, entity="website-products")
        return 1
    if "--send" in sys.argv:
        reported = terminal_heartbeat(
            result == 0,
            None if result == 0 else "Website catalogue import failed",
            entity="website-products",
        )
        if result == 0 and not reported:
            return 1
    return result


if __name__ == "__main__":
    try:
        with install_run_lock("website catalogue import"):
            sys.exit(main())
    except GatiRunAlreadyActive as exc:
        print(f"[STOP] {exc}")
        sys.exit(2)
    except KeyboardInterrupt as exc:
        print("\n  Stopped before the website catalogue import completed.")
        if "--send" in sys.argv:
            terminal_heartbeat(
                False, exc, phase="interrupted", entity="website-products"
            )
        sys.exit(130)
