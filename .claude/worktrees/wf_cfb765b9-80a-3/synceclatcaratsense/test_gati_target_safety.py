import os
import unittest
from pathlib import Path
from unittest.mock import patch

import gati_target_safety as safety


class TargetSafetyTests(unittest.TestCase):
    package = Path(__file__).resolve().parent

    def test_backend_requires_an_exact_explicit_approval(self):
        self.assertEqual(
            safety.require_approved_backend(
                "HTTPS://API.Example.test:443/", "https://api.example.test"
            ),
            "https://api.example.test",
        )
        with self.assertRaisesRegex(safety.TargetSafetyError, "missing"):
            safety.require_approved_backend("https://api.example.test", "")
        with self.assertRaisesRegex(safety.TargetSafetyError, "does not match"):
            safety.require_approved_backend(
                "https://api.example.test", "https://other.example.test"
            )

    def test_backend_rejects_deceptive_or_unsafe_origins(self):
        bad = [
            "backend-production.example.test.evil.invalid/path",
            "https://user:password@example.test",
            "http://api.example.test",
            "https://api.example.test/path",
            "https://api.example.test?next=prod",
            "https://api.example.test\\@evil.invalid",
            "",
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(safety.TargetSafetyError):
                safety.normalize_backend_origin(value)

    def test_loopback_http_and_ipv6_are_allowed_only_when_approved(self):
        for value in ("http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"):
            with self.subTest(value=value):
                self.assertEqual(safety.require_approved_backend(value, value), value)

    def test_website_endpoint_and_public_origin_have_no_hidden_default(self):
        endpoint, origin = safety.require_approved_website(
            "https://feeds.example.test/v1/products?page=1",
            "https://feeds.example.test/v1/products?page=1",
            "https://shop.example.test",
        )
        self.assertEqual(endpoint, "https://feeds.example.test/v1/products?page=1")
        self.assertEqual(origin, "https://shop.example.test")
        with self.assertRaisesRegex(safety.TargetSafetyError, "missing"):
            safety.require_approved_website("", "", "")
        with self.assertRaisesRegex(safety.TargetSafetyError, "does not match"):
            safety.require_approved_website(
                "https://feeds.example.test/v1/products",
                "https://feeds.example.test/v2/products",
                "https://shop.example.test",
            )

    def test_cli_refuses_missing_settings_before_network_use(self):
        names = (
            "ECLAT_BASE_URL",
            "CARATOS_APPROVED_BACKEND_ORIGIN",
            "ECLAT_WEBSITE_API",
            "ECLAT_APPROVED_WEBSITE_API",
            "ECLAT_WEBSITE_ORIGIN",
        )
        with patch.dict(os.environ, {name: "" for name in names}, clear=False):
            self.assertEqual(safety.main(["backend"]), 20)
            self.assertEqual(safety.main(["website"]), 20)

    def test_executable_sources_ship_without_the_old_live_defaults(self):
        sources = "\n".join(
            (self.package / name).read_text(encoding="utf-8")
            for name in ("configure.py", "import_website.py", "check_website_match.py")
        ).casefold()
        self.assertNotIn("backend-production-89dd.up.railway.app", sources)
        self.assertNotIn("apis.eclatdiamonds.in/v1/api/products", sources)

    def test_every_networked_batch_entry_point_runs_the_target_gate(self):
        expected = {
            "3_test.bat": "backend",
            "4_preview.bat": "backend",
            "5_first_sync.bat": "backend",
            "run_sync.bat": "backend",
            "sync_media.bat": "backend",
            "check_website_match.bat": "website",
            "import_website.bat": "website",
        }
        for filename, target_type in expected.items():
            with self.subTest(filename=filename):
                source = (self.package / filename).read_text(encoding="utf-8")
                self.assertIn(f"gati_target_safety.py {target_type}", source)


if __name__ == "__main__":
    unittest.main()
