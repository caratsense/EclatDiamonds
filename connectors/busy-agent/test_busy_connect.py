import tempfile
import unittest
from pathlib import Path

from busy_connect import (
    CaratOSClient,
    HEADERS,
    choose_column,
    csv_bytes,
    database_paths,
    env_flag,
    fingerprint,
    safe_error,
)


class BusyConnectHelpersTest(unittest.TestCase):
    def test_candidate_columns_are_case_insensitive(self):
        columns = {"mobile": "Mobile", "emailid": "EmailId"}
        self.assertEqual(choose_column(columns, "phone", "mobile"), "Mobile")
        self.assertEqual(choose_column(columns, "email", "emailid"), "EmailId")

    def test_csv_uses_canonical_headers(self):
        payload = csv_bytes([{"name": "Asha", "phone": "9876543210"}]).decode("utf-8-sig")
        self.assertEqual(payload.splitlines()[0].split(","), HEADERS)
        self.assertIn("Asha,9876543210", payload)

    def test_paths_and_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "company.bds"
            source.write_bytes(b"one")
            self.assertEqual(database_paths(str(source)), [source])
            first = fingerprint(source)
            source.write_bytes(b"two-two")
            self.assertNotEqual(first, fingerprint(source))

    def test_remote_api_requires_https(self):
        with self.assertRaisesRegex(RuntimeError, "must use HTTPS"):
            CaratOSClient("http://crm.example.com", "cxa_test")
        self.assertEqual(CaratOSClient("http://localhost:4000", "cxa_test").base_url, "http://localhost:4000")

    def test_errors_redact_agent_and_database_secrets(self):
        message = safe_error(
            RuntimeError("token cxa_secret failed; PWD=hunter2; password=other"),
            "cxa_secret",
            "hunter2",
        )
        self.assertNotIn("cxa_secret", message)
        self.assertNotIn("hunter2", message)
        self.assertNotIn("other", message)
        self.assertIn("[REDACTED]", message)


if __name__ == "__main__":
    unittest.main()
