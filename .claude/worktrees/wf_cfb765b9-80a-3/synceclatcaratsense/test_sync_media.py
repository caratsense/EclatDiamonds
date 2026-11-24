import copy
import unittest
from unittest.mock import Mock, patch

import sync_media as media


class Response:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text

    def json(self):
        return self._body


class PhotoLinkLedgerTests(unittest.TestCase):
    def setUp(self):
        self.old_backends = media.BACKENDS
        self.old_approved_backend = media.APPROVED_BACKEND
        self.old_dry_run = media.DRY_RUN
        self.old_limit = media.LIMIT
        self.old_pillow = media._PILImage
        media.BACKENDS = ["https://api.example.test"]
        media.APPROVED_BACKEND = "https://api.example.test"
        media.DRY_RUN = False
        media.LIMIT = None
        media._PILImage = None
        media.APPROVAL_HEADERS.clear()

    def tearDown(self):
        media.BACKENDS = self.old_backends
        media.APPROVED_BACKEND = self.old_approved_backend
        media.DRY_RUN = self.old_dry_run
        media.LIMIT = self.old_limit
        media._PILImage = self.old_pillow
        media.APPROVAL_HEADERS.clear()
        media.HEARTBEATS.clear()

    def _main_patches(self, ledger, client, login, push):
        connection = Mock()
        connection.cursor.return_value = Mock()
        target = {"kind": "product", "legacyId": "P-1", "filename": "p1.jpg"}
        return (
            patch.object(media, "check_config", return_value=("r2", client)),
            patch.object(media, "connect_sql", return_value=connection),
            patch.object(media, "collect_targets", return_value=[target]),
            patch.object(media, "build_file_index", return_value={"p1.jpg": "C:/photos/p1.jpg"}),
            patch.object(media, "load_ledger", return_value=ledger),
            patch.object(media, "save_ledger"),
            patch.object(media, "login", side_effect=login),
            patch.object(media, "push_images", side_effect=push),
        )

    def test_approval_failure_happens_before_storage_upload(self):
        ledger = {}
        client = Mock()
        patches = self._main_patches(
            ledger,
            client,
            login=RuntimeError("not approved"),
            push=Mock(),
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            self.assertEqual(media.main(), 1)
        client.upload_file.assert_not_called()

    def test_uploaded_but_unlinked_is_retried_without_reupload(self):
        ledger = {}
        client = Mock()
        client.upload_file.return_value = "https://cdn.example.test/catalogue/product_P-1.jpg"
        link_attempt = 0

        def login(base):
            media.APPROVAL_HEADERS[base] = {
                "Authorization": "Bearer restricted-test",
                "Content-Type": "application/json",
            }

        def push(base, records, acknowledged):
            nonlocal link_attempt
            link_attempt += 1
            if link_attempt == 1:
                return False
            acknowledged(records)
            return True

        patches = self._main_patches(ledger, client, login=login, push=push)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            self.assertEqual(media.main(), 1)
            entry_after_failure = copy.deepcopy(ledger["product:P-1"])
            self.assertEqual(
                media._uploaded_url(entry_after_failure),
                "https://cdn.example.test/catalogue/product_P-1.jpg",
            )
            self.assertFalse(media._is_linked(entry_after_failure, media.BACKENDS[0]))

            self.assertEqual(media.main(), 0)

        client.upload_file.assert_called_once()
        self.assertTrue(media._is_linked(ledger["product:P-1"], media.BACKENDS[0]))

    def test_legacy_ledger_url_is_uploaded_but_not_linked(self):
        entry = {
            "url": "https://cdn.example.test/old.jpg",
            "file": "old.jpg",
            "at": "2026-09-08T12:00:00",
        }
        self.assertEqual(media._uploaded_url(entry), "https://cdn.example.test/old.jpg")
        self.assertFalse(media._is_linked(entry, "https://api.example.test"))

    def test_only_exact_full_acknowledgment_is_accepted(self):
        base = media.BACKENDS[0]
        media.APPROVAL_HEADERS[base] = {
            "Authorization": "Bearer restricted-test",
            "Content-Type": "application/json",
        }
        records = [
            {"kind": "product", "legacyId": "P-1", "imageUrl": "https://cdn/p1.jpg"}
        ]
        acknowledged = Mock()
        response = Response(
            body={
                "entity": "product-images",
                "received": 1,
                "upserted": 1,
                "skipped": 0,
                "watermark": None,
            }
        )
        with patch.object(media.requests, "post", return_value=response) as post:
            self.assertTrue(media.push_images(base, records, acknowledged))
        acknowledged.assert_called_once_with(records)
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

        acknowledged.reset_mock()
        partial = Response(
            body={
                "entity": "product-images",
                "received": 1,
                "upserted": 0,
                "skipped": 1,
            }
        )
        with patch.object(media.requests, "post", return_value=partial):
            self.assertFalse(media.push_images(base, records, acknowledged))
        acknowledged.assert_not_called()

        acknowledged.reset_mock()
        missing_contract_field = Response(
            body={
                "entity": "product-images",
                "received": 1,
                "upserted": 1,
                "skipped": 0,
            }
        )
        with patch.object(media.requests, "post", return_value=missing_contract_field):
            self.assertFalse(media.push_images(base, records, acknowledged))
        acknowledged.assert_not_called()

    def test_generation_change_stops_storage_and_link_uploads(self):
        ledger = {}
        client = Mock()
        link = Mock()

        def login(base):
            media.APPROVAL_HEADERS[base] = {
                "Authorization": "Bearer restricted-test",
                "Content-Type": "application/json",
            }

        patches = self._main_patches(ledger, client, login=login, push=link)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patch.object(
            media, "heartbeat", side_effect=RuntimeError("configuration changed")
        ):
            self.assertEqual(media.main(), 1)

        client.upload_file.assert_not_called()
        link.assert_not_called()

        base = media.BACKENDS[0]
        media.APPROVAL_HEADERS[base] = {
            "Authorization": "Bearer restricted-test",
            "Content-Type": "application/json",
        }
        records = [
            {"kind": "product", "legacyId": "P-1", "imageUrl": "https://cdn/p1.jpg"}
        ]
        with patch.object(
            media, "heartbeat", side_effect=RuntimeError("configuration changed")
        ), patch.object(media.requests, "post") as post:
            self.assertFalse(media.push_images(base, records))
        post.assert_not_called()

    def test_main_reports_terminal_success_and_failure(self):
        reporter = Mock()

        def successful_run():
            media.HEARTBEATS[media.BACKENDS[0]] = reporter
            return 0

        with patch.object(media, "_main", side_effect=successful_run):
            self.assertEqual(media.main(), 0)
        reporter.success.assert_called_once()
        reporter.error.assert_not_called()

        reporter.reset_mock()

        def failed_run():
            media.HEARTBEATS[media.BACKENDS[0]] = reporter
            raise RuntimeError("storage upload failed")

        with patch.object(media, "_main", side_effect=failed_run):
            self.assertEqual(media.main(), 1)
        reporter.error.assert_called_once()
        reporter.success.assert_not_called()


if __name__ == "__main__":
    unittest.main()
