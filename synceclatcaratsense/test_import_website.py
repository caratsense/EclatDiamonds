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


class WebsiteImportLifecycleTests(unittest.TestCase):
    def test_push_requires_a_complete_acknowledgement(self):
        valid = {
            "entity": "website-products",
            "received": 1,
            "upserted": 1,
            "skipped": 0,
            "created": 1,
            "enriched": 0,
        }
        website.APPROVAL_HEADERS.clear()
        website.APPROVAL_HEADERS["Authorization"] = "Bearer restricted-test"
        with patch.object(website, "BASE_URL", "https://api.example.test"), patch.object(
            website.NO_REDIRECT_OPENER, "open", return_value=OpenResponse(valid)
        ):
            self.assertEqual(website.push("unused", [{"productCode": "P-1"}]), (1, 0, 0))

        partial = {**valid, "received": 2}
        with patch.object(website, "BASE_URL", "https://api.example.test"), patch.object(
            website.NO_REDIRECT_OPENER, "open", return_value=OpenResponse(partial)
        ), self.assertRaisesRegex(RuntimeError, "did not cover"):
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


if __name__ == "__main__":
    unittest.main()
