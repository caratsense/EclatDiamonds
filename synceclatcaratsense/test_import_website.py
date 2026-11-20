import json
import sys
import unittest
from unittest.mock import Mock, patch

import import_website as website


class OpenResponse:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self._body).encode("utf-8")


def fake_site(products, total=None, fail_after=None):
    """A paginating website; `total` defaults to the real count."""
    calls = []

    def fetch(page, limit):
        calls.append(page)
        chunk = products[(page - 1) * limit: page * limit]
        if fail_after is not None and page > fail_after:
            chunk = []
        t = len(products) if total is None else total
        return chunk, t, max(1, -(-t // limit))

    return fetch, calls


class WebsitePaginationTests(unittest.TestCase):
    def test_reads_every_page_to_the_source_total(self):
        products = [{"productCode": f"P{i}"} for i in range(250)]
        fetch, calls = fake_site(products)
        got, total, complete = website.fetch_all(limit=100, fetch=fetch)
        self.assertEqual(calls, [1, 2, 3])
        self.assertEqual(len(got), 250)
        self.assertEqual(total, 250)
        self.assertTrue(complete)

    def test_short_page_is_not_complete(self):
        products = [{"productCode": f"P{i}"} for i in range(250)]
        fetch, _ = fake_site(products, fail_after=1)
        got, total, complete = website.fetch_all(limit=100, fetch=fetch)
        self.assertEqual((len(got), total, complete), (100, 250, False))

    def test_no_total_is_never_complete(self):
        def fetch(page, limit):
            return ([{"productCode": "A"}] if page == 1 else []), None, None

        self.assertEqual(website.fetch_all(limit=100, fetch=fetch), ([{"productCode": "A"}], None, False))

    def test_payloads_are_passed_through_untouched(self):
        rich = {
            "productCode": " 11871RG ",
            "variantType": [{"name": c, "shapes": [{"images": [f"https://cdn/{c}{i}.jpg" for i in range(9)]}]}
                            for c in ("rose", "white", "yellow")],
            "variants": [{"karat": k, "billOfMaterial": [{"rawMaterialId": "x"}]} for k in ("9KT", "14KT", "18KT")],
            "indicativePrice": 185000,
            "minVariantPrice": 155392.1,
        }
        fetch, _ = fake_site([rich])
        got, _, _ = website.fetch_all(limit=100, fetch=fetch)
        self.assertIs(got[0], rich)  # no reduction, no 12-image cap, no price choice

    def test_page_url_keeps_the_approved_query(self):
        url = website.page_url("https://apis.example.test/api/products?country=IN&page=9", 2, 100)
        self.assertEqual(url, "https://apis.example.test/api/products?country=IN&page=2&limit=100")

    def test_parse_page_envelopes(self):
        self.assertEqual(website.parse_page({"data": [1], "total": 5, "totalPages": 1}), ([1], 5, 1))
        self.assertEqual(website.parse_page({"data": {"products": [], "pagination": {"total": "7"}}}), ([], 7, None))
        with self.assertRaises(RuntimeError):
            website.parse_page({"nothing": True})


class WebsiteImportLifecycleTests(unittest.TestCase):
    def ack(self, received, **extra):
        return {"entity": "website-raw", "runId": "run-1", "received": received,
                "upserted": received, "skipped": 0, "created": received, **extra}

    def test_push_sends_batches_under_one_run_then_closes_it(self):
        website.APPROVAL_HEADERS.clear()
        website.APPROVAL_HEADERS["Authorization"] = "Bearer restricted-test"
        sent = []

        def opened(req, timeout):
            body = json.loads(req.data.decode())
            sent.append(body)
            n = len(body["products"])
            return OpenResponse(self.ack(n, status="done" if body.get("final") else "running"))

        products = [{"productCode": f"P{i}"} for i in range(30)]
        with patch.object(website, "BASE_URL", "https://api.example.test"), patch.object(
            website.NO_REDIRECT_OPENER, "open", side_effect=opened
        ):
            result = website.push("unused", products, total=30, complete=True)
        self.assertEqual(result, (30, 0, 0, 0, "done"))
        self.assertEqual([len(b["products"]) for b in sent], [25, 5, 0])
        self.assertNotIn("runId", sent[0])
        self.assertEqual(sent[1]["runId"], "run-1")
        self.assertEqual(sent[2], {"products": [], "final": True, "complete": True, "runId": "run-1", "expected": 30})

    def test_push_requires_a_complete_acknowledgement(self):
        website.APPROVAL_HEADERS.clear()
        with patch.object(website, "BASE_URL", "https://api.example.test"), patch.object(
            website.NO_REDIRECT_OPENER, "open", return_value=OpenResponse(self.ack(2))
        ), self.assertRaisesRegex(RuntimeError, "did not cover"):
            website.push("unused", [{"productCode": "P-1"}])
        wrong = {**self.ack(1), "entity": "website-products"}
        with patch.object(website, "BASE_URL", "https://api.example.test"), patch.object(
            website.NO_REDIRECT_OPENER, "open", return_value=OpenResponse(wrong)
        ), self.assertRaisesRegex(RuntimeError, "invalid acknowledgement"):
            website.push("unused", [{"productCode": "P-1"}])

    def test_generation_change_prevents_website_upload(self):
        website.APPROVAL_HEADERS.clear()
        website.APPROVAL_HEADERS["Authorization"] = "Bearer restricted-test"
        with patch.object(website, "BASE_URL", "https://api.example.test"), patch.object(
            website, "heartbeat", side_effect=RuntimeError("configuration changed")
        ), patch.object(website.NO_REDIRECT_OPENER, "open") as opened, self.assertRaisesRegex(
            RuntimeError, "configuration changed"
        ):
            website.push("unused", [{"productCode": "P-1"}])
        opened.assert_not_called()

    def test_main_reports_terminal_success_and_error(self):
        success_reporter = Mock()

        def successful_run():
            website.HEARTBEAT = success_reporter
            return 0

        with patch.object(sys, "argv", ["import_website.py", "--send"]), patch.object(
            website, "_main", side_effect=successful_run
        ):
            self.assertEqual(website.main(), 0)
        success_reporter.success.assert_called_once()
        success_reporter.error.assert_not_called()

        error_reporter = Mock()

        def failed_run():
            website.HEARTBEAT = error_reporter
            raise RuntimeError("upload failed")

        with patch.object(sys, "argv", ["import_website.py", "--send"]), patch.object(
            website, "_main", side_effect=failed_run
        ):
            self.assertEqual(website.main(), 1)
        error_reporter.error.assert_called_once()
        error_reporter.success.assert_not_called()

    def test_preview_sends_nothing(self):
        with patch.object(sys, "argv", ["import_website.py"]), patch.object(
            website, "fetch_all", return_value=([{"productCode": "P1", "name": "Ring"}], 1, True)
        ), patch.object(website.NO_REDIRECT_OPENER, "open") as opened:
            self.assertEqual(website._main(), 0)
        opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
