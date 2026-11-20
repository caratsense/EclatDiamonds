"""
Eclat / CaratSense — bring the WEBSITE catalogue into Eclat, losslessly.

Why the website at all, when the shop has its own picture folder:

  The pictures in D:\\GATISOFTTECH\\SJEP IMAGES are the WORKING library. A large
  share of them have the measurements and specification printed across the
  image — right for the workshop, wrong for a customer. The website carries
  the retouched shots the client publishes, already on a public CDN, plus
  every variant (9KT / 14KT / 18KT ...), size, price and bill of material.

What this does:

  Reads EVERY page of the website's product API until the website's own total
  is reached, and sends each product exactly as the website published it — no
  reduction, no picture cap, no choosing one price — to Eclat
  (POST /sync/website/raw). Eclat keeps the payload verbatim, joins it to the
  Gati design with the same code, and records anything it will not guess about
  as a catalogue conflict for head office.

  Only a COMPLETE read (every page, the website's total reached) lets Eclat
  retire designs or photographs the website no longer shows. A partial read
  adds and updates, and removes nothing.

Read-only against the website. Touches SQL Server not at all.

Run:  import_website.bat            see what would happen, send nothing
      import_website.bat --send     do it

Optional: ECLAT_WEBSITE_TOKEN — a read-only service token from the website team,
sent as a bearer. Never printed.
"""
import json
import os
import sys
import urllib.parse
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
WEBSITE_TOKEN = (os.getenv("ECLAT_WEBSITE_TOKEN") or "").strip()
BASE_URL = (os.getenv("ECLAT_BASE_URL") or "").strip().rstrip("/")
APPROVED_BACKEND = (os.getenv("CARATOS_APPROVED_BACKEND_ORIGIN") or "").strip()
AGENT_TOKEN = (os.getenv("CARATOS_AGENT_TOKEN") or "").strip()
SQL_SERVER = (os.getenv("SJEP_SQL_SERVER") or r"localhost\SQLEXPRESS").strip()
SQL_DB = (os.getenv("SJEP_SQL_DB") or "APRSSJEP").strip()
APPROVAL_HEADERS = {}
HEARTBEAT = None
# Products per upload. Whole payloads are large (every variant, BOM line and
# photograph), and the server writes each batch in one transaction.
CHUNK = 25
PAGE_SIZE = 100
ENTITY = "website-raw"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def page_url(endpoint, page, limit):
    """The approved endpoint with page/limit set; every other query kept."""
    parts = urllib.parse.urlsplit(endpoint)
    query = [
        (k, v)
        for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if k not in ("page", "limit")
    ]
    query += [("page", str(page)), ("limit", str(limit))]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _count(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if v >= 0 else None
    if isinstance(v, str) and v.strip().isdigit():
        return int(v.strip())
    return None


def parse_page(body):
    """(products, total, totalPages) from any envelope the feed has used."""
    data = body.get("data") if isinstance(body, dict) else None
    if isinstance(body, list):
        products = body
    elif isinstance(data, list):
        products = data
    elif isinstance(data, dict) and isinstance(data.get("products"), list):
        products = data["products"]
    elif isinstance(data, dict) and isinstance(data.get("docs"), list):
        products = data["docs"]
    elif isinstance(body, dict) and any(isinstance(body.get(k), list) for k in ("products", "items", "docs")):
        products = next(body[k] for k in ("products", "items", "docs") if isinstance(body.get(k), list))
    else:
        raise RuntimeError("website response has no product list")
    holders = [body, data]
    for h in (body, data):
        if isinstance(h, dict):
            holders += [h.get("pagination"), h.get("meta")]
    holders = [h for h in holders if isinstance(h, dict)]

    def pick(keys):
        for h in holders:
            for k in keys:
                n = _count(h.get(k))
                if n is not None:
                    return n
        return None

    return (
        products,
        pick(("total", "totalCount", "totalDocs", "totalProducts", "totalItems")),
        pick(("totalPages", "pages", "pageCount")),
    )


def fetch_page(page, limit=PAGE_SIZE):
    endpoint, public_origin = require_approved_website(
        WEBSITE_API, APPROVED_WEBSITE_API, WEBSITE_ORIGIN
    )
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Origin": public_origin,
        "Referer": f"{public_origin}/",
        "Accept": "application/json",
    }
    if WEBSITE_TOKEN:
        headers["Authorization"] = f"Bearer {WEBSITE_TOKEN}"
    req = urllib.request.Request(page_url(endpoint, page, limit), headers=headers)
    # A configured feed cannot redirect this one-click command to an unreviewed
    # host. Review and pin the final endpoint instead.
    with NO_REDIRECT_OPENER.open(req, timeout=90) as r:
        return parse_page(json.loads(r.read().decode()))


def fetch_all(limit=PAGE_SIZE, fetch=None):
    """Every page until the website's own total is reached.

    Returns (products, total, complete). `complete` is True only when the feed
    reported a total, every page up to it came back full, and that many
    products arrived. Eclat removes nothing on anything less.
    """
    fetch = fetch or fetch_page
    products, total, page = [], None, 1
    while True:
        items, page_total, total_pages = fetch(page, limit)
        if page_total is not None:
            total = page_total
        products.extend(items)
        heartbeat("reading", entity=ENTITY, rowsRead=len(products))
        if total is None:
            # No total: completeness cannot be proven. Stop on a short page.
            if len(items) < limit:
                return products, None, False
        else:
            pages = total_pages or max(1, -(-total // limit))
            if page >= pages:
                return products, total, len(products) >= total
            if len(items) < limit:
                return products, total, False  # a short page before the last
        page += 1


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
    if not isinstance(value, dict) or value.get("entity") != ENTITY:
        raise RuntimeError("website import returned an invalid acknowledgement")
    counts = {name: value.get(name) for name in ("received", "upserted", "skipped")}
    if any(type(number) is not int or number < 0 for number in counts.values()):
        raise RuntimeError("website import returned invalid acknowledgement counts")
    if counts["received"] != expected or counts["upserted"] + counts["skipped"] != expected:
        raise RuntimeError("website import acknowledgement did not cover the sent batch")
    if not isinstance(value.get("runId"), str) or not value["runId"]:
        raise RuntimeError("website import acknowledgement has no run id")
    return value


def _post(body):
    req = urllib.request.Request(
        f"{BASE_URL}/sync/website/raw",
        data=json.dumps(body).encode(),
        headers=dict(APPROVAL_HEADERS),
    )
    # Never forward the restricted machine bearer through an HTTP redirect.
    with NO_REDIRECT_OPENER.open(req, timeout=300) as r:
        return json.loads(r.read().decode())


def push(token, products, total=None, complete=False):
    """Send raw payloads in batches under one Eclat sync run, then close it.

    Returns (created, updated, unchanged, failed, final run status).
    """
    run_id = None
    created = updated = unchanged = failed = 0
    for i in range(0, len(products), CHUNK):
        batch = products[i:i + CHUNK]
        heartbeat("uploading", entity=ENTITY, rowsRead=i, rowsReady=len(products))
        body = {"products": batch}
        if run_id:
            body["runId"] = run_id
        if total is not None:
            body["expected"] = total
        res = _validated_acknowledgement(_post(body), len(batch))
        run_id = res["runId"]
        created += res.get("created", 0)
        updated += res.get("updated", 0)
        unchanged += res.get("unchanged", 0)
        failed += res.get("failed", 0)
        print(f"    sent {i + len(batch)}/{len(products)}  created={created} "
              f"updated={updated} unchanged={unchanged} failed={failed}")
    final = {"products": [], "final": True, "complete": bool(complete)}
    if run_id:
        final["runId"] = run_id
    if total is not None:
        final["expected"] = total
    res = _validated_acknowledgement(_post(final), 0)
    return created, updated, unchanged, failed, res.get("status")


def _main():
    send = "--send" in sys.argv
    print("=" * 72)
    print("  WEBSITE CATALOGUE -> ECLAT (lossless)")
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
        products, total, complete = fetch_all()
    except Exception as e:
        print(f"\n[STOP] Could not read the website: {str(e)[:200]}")
        print("       No internet on this machine, or a proxy is blocking it.")
        return 1
    coded = sum(1 for p in products if isinstance(p, dict) and str(p.get("productCode") or "").strip())
    print(f"\n  website total          : {total if total is not None else 'not reported'}")
    print(f"  designs received       : {len(products):,}")
    print(f"  with a design code     : {coded:,}")
    print(f"  complete read          : {'yes' if complete else 'NO — Eclat will add/update but remove nothing'}")

    if not products:
        print("\n  Nothing to import.")
        return 1

    print("\n  first three:")
    for p in products[:3]:
        p = p if isinstance(p, dict) else {}
        print(f"    {str(p.get('productCode') or '').strip():<16} {str(p.get('name') or '').strip()[:48]}")

    if not send:
        print("\n" + "=" * 72)
        print("  Nothing was sent. To do it for real:")
        print("     import_website.bat --send")
        print("=" * 72)
        return 0

    created, updated, unchanged, failed, status = push(AGENT_TOKEN, products, total, complete)
    print("\n" + "=" * 72)
    print(f"  DONE (run {status}). {created} new, {updated} updated, {unchanged} unchanged, "
          f"{failed} could not be read (see catalogue conflicts in Eclat).")
    print("  Photographs stay on the website's CDN; nothing in the shop system")
    print("  was touched.")
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
        terminal_heartbeat(False, exc, entity=ENTITY)
        return 1
    if "--send" in sys.argv:
        reported = terminal_heartbeat(
            result == 0,
            None if result == 0 else "Website catalogue import failed",
            entity=ENTITY,
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
                False, exc, phase="interrupted", entity=ENTITY
            )
        sys.exit(130)
