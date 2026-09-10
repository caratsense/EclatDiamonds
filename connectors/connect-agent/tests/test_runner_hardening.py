import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from caratos_connect.profile import profile_fingerprint, source_instance_fingerprint
from caratos_connect.runner import preview, sync


class FakeSource:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def extract(self, _definition, limit, detect_overflow=True):
        return self.rows[:limit]


class FakeClient:
    def __init__(self, profile, *, validation=None, upload_counts=None, revision="1"):
        self.profile = profile
        self.validation = validation
        self.upload_counts = upload_counts
        self.revision = revision
        self.uploads = 0
        self.run_keys = []

    def me(self, _expected_source):
        return self.identity()

    def identity(self, *, approved=True):
        return {
            "agentId": "agent-1",
            "organisationId": "org-1",
            "sourceSystem": "busy",
            "storeId": None,
            "protocolVersion": 1,
            "minimumAgentVersion": "0.2.0",
            "maximumAgentVersion": "9.0.0",
            "enabled": True,
            "expectedProfileHash": profile_fingerprint(self.profile) if approved else None,
            "expectedSourceInstanceHash": source_instance_fingerprint(self.profile),
            "configRevision": self.revision,
            "batchSize": 5000,
            "syncIntervalMinutes": 15,
        }

    def heartbeat(self, *_args, **_kwargs):
        return {"enabled": True}

    def validate(self, _source, _profile, _entity, rows, *_args):
        if self.validation is not None:
            return dict(self.validation)
        return {"total": len(rows), "valid": len(rows), "warning": 0, "error": 0}

    def upload(self, _source, _profile, _entity, rows, _store, run_key, *_args):
        self.uploads += 1
        self.run_keys.append(run_key)
        if self.upload_counts is not None:
            return {"counts": dict(self.upload_counts)}
        return {
            "counts": {
                "discovered": len(rows),
                "imported": len(rows),
                "updated": 0,
                "skipped": 0,
                "duplicate": 0,
                "failed": 0,
            }
        }


class RunnerHardeningTests(unittest.TestCase):
    PROFILE = {
        "schemaVersion": 1,
        "id": "runner-hardening",
        "sourceSystem": "busy",
        "transport": {"kind": "odbc", "connectionEnv": "CONNECT_SOURCE_DSN"},
        "entities": {
            "customers": {
                "fields": {"code": ["id"], "name": ["name"], "city": ["city"]},
                "prefixValues": {"code": "busy:"},
            }
        },
    }

    def env(self):
        return patch.dict(
            os.environ,
            {"CONNECT_SOURCE_DSN": "server=test;database=one;uid=readonly;pwd=secret"},
        )

    def test_default_preview_masks_every_value_and_reports_review_hash(self):
        sentinel = {
            "id": "PRIVATE-CODE-711",
            "name": "Sensitive Person",
            "city": "Secret City",
        }
        with self.env(), patch("caratos_connect.runner.source_for", return_value=FakeSource([sentinel])):
            result = preview(self.PROFILE)
            expected_source_hash = source_instance_fingerprint(self.PROFILE)
        rendered = json.dumps(result)
        for value in sentinel.values():
            self.assertNotIn(value, rendered)
        self.assertEqual(result["profileHash"], profile_fingerprint(self.PROFILE))
        self.assertEqual(
            result["sourceInstanceHash"], expected_source_hash
        )
        self.assertIn("length=", rendered)

    def test_live_sync_rejects_unapproved_profile_before_source_access(self):
        client = FakeClient(self.PROFILE)
        with self.env(), patch("caratos_connect.runner.source_for") as source, self.assertRaisesRegex(
            RuntimeError, "requires this exact connector profile hash"
        ):
            sync(
                self.PROFILE,
                client,
                Path("unused"),
                identity=client.identity(approved=False),
            )
        source.assert_not_called()

    def test_live_sync_rejects_unapproved_source_descriptor_before_source_access(self):
        client = FakeClient(self.PROFILE)
        with self.env():
            identity = client.identity()
            identity["expectedSourceInstanceHash"] = None
            with patch("caratos_connect.runner.source_for") as source, self.assertRaisesRegex(
                RuntimeError, "requires this exact source descriptor hash"
            ):
                sync(self.PROFILE, client, Path("unused"), identity=identity)
        source.assert_not_called()

    def test_server_warning_blocks_upload_and_checkpoint(self):
        client = FakeClient(
            self.PROFILE,
            validation={"total": 1, "valid": 0, "warning": 1, "error": 0},
        )
        with tempfile.TemporaryDirectory() as directory, self.env(), patch(
            "caratos_connect.runner.source_for",
            return_value=FakeSource([{"id": "1", "name": "Warning"}]),
        ), self.assertRaisesRegex(RuntimeError, "held 1 warning"):
            sync(self.PROFILE, client, Path(directory))
            self.fail("warning-bearing sync unexpectedly completed")
        self.assertEqual(client.uploads, 0)
        self.assertEqual(list(Path(directory).glob("*.json")), [])

    def test_empty_or_fully_filtered_entity_needs_explicit_review(self):
        for rows in ([], [{"id": "1", "name": "Filtered", "kind": "supplier"}]):
            profile = json.loads(json.dumps(self.PROFILE))
            profile["entities"]["customers"]["fields"]["_kind"] = ["kind"]
            profile["entities"]["customers"]["include"] = [
                {"field": "_kind", "equalsAny": ["customer"]}
            ]
            client = FakeClient(profile)
            with self.subTest(rows=rows), tempfile.TemporaryDirectory() as directory, self.env(), patch(
                "caratos_connect.runner.source_for", return_value=FakeSource(rows)
            ), self.assertRaisesRegex(RuntimeError, "allowEmpty=true"):
                sync(
                    profile,
                    client,
                    Path(directory),
                    dry_run=True,
                    identity=client.identity(approved=False),
                )

        allowed = json.loads(json.dumps(self.PROFILE))
        allowed["entities"]["customers"]["allowEmpty"] = True
        client = FakeClient(allowed)
        with tempfile.TemporaryDirectory() as directory, self.env(), patch(
            "caratos_connect.runner.source_for", return_value=FakeSource([])
        ):
            result = sync(
                allowed,
                client,
                Path(directory),
                dry_run=True,
                identity=client.identity(approved=False),
            )
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(client.uploads, 0)

    def test_upload_acknowledgement_must_exactly_account_for_payload(self):
        bad_counts = (
            {},
            {"discovered": 0, "imported": 0, "updated": 0, "skipped": 0, "duplicate": 0, "failed": 0},
            {"discovered": 1, "imported": "1", "updated": 0, "skipped": 0, "duplicate": 0, "failed": 0},
            {"discovered": 1, "imported": 1, "updated": 0, "skipped": -1, "duplicate": 0, "failed": 1},
            {"discovered": 1, "imported": 0, "updated": 0, "skipped": 1, "duplicate": 0, "failed": 0},
        )
        for counts in bad_counts:
            client = FakeClient(self.PROFILE, upload_counts=counts)
            with self.subTest(counts=counts), tempfile.TemporaryDirectory() as directory, self.env(), patch(
                "caratos_connect.runner.source_for",
                return_value=FakeSource([{"id": "1", "name": "Asha"}]),
            ):
                with self.assertRaisesRegex(RuntimeError, "state not advanced"):
                    sync(self.PROFILE, client, Path(directory))
                checkpoints = list(Path(directory).glob("*.json"))
                self.assertEqual(len(checkpoints), 1)
                pending = json.loads(checkpoints[0].read_text(encoding="utf-8"))
                self.assertTrue(any('"attemptId"' in value for value in pending.values()))

    def test_ambiguous_upload_retry_reuses_the_persisted_attempt_receipt(self):
        class AmbiguousClient(FakeClient):
            def upload(self, *args, **kwargs):
                result = super().upload(*args, **kwargs)
                if self.uploads == 1:
                    raise TimeoutError("response lost after upload")
                return result

        client = AmbiguousClient(self.PROFILE)
        with tempfile.TemporaryDirectory() as directory, self.env(), patch(
            "caratos_connect.runner.source_for",
            return_value=FakeSource([{"id": "1", "name": "Asha"}]),
        ):
            with self.assertRaisesRegex(RuntimeError, "response lost"):
                sync(self.PROFILE, client, Path(directory))
            checkpoint = next(Path(directory).glob("*.json"))
            pending = json.loads(checkpoint.read_text(encoding="utf-8"))
            self.assertTrue(any('"attemptId"' in value for value in pending.values()))

            sync(self.PROFILE, client, Path(directory))
            completed = json.loads(checkpoint.read_text(encoding="utf-8"))

        self.assertEqual(client.uploads, 2)
        self.assertEqual(client.run_keys[0], client.run_keys[1])
        self.assertFalse(any('"attemptId"' in value for value in completed.values()))

    def test_config_revision_forces_a_new_checkpoint_and_run_receipt(self):
        with tempfile.TemporaryDirectory() as directory, self.env(), patch(
            "caratos_connect.runner.source_for",
            return_value=FakeSource([{"id": "1", "name": "Asha"}]),
        ):
            client = FakeClient(self.PROFILE, revision="1")
            sync(self.PROFILE, client, Path(directory))
            client.revision = "restore-2"
            sync(self.PROFILE, client, Path(directory))
        self.assertEqual(client.uploads, 2)
        self.assertEqual(len(set(client.run_keys)), 2)

    def test_returning_to_an_older_snapshot_uses_a_new_receipt(self):
        source = FakeSource([{"id": "1", "name": "Asha"}])
        # Each completed sync reads the clock once for the due check and once
        # when it writes the next scheduled time. Keep every call beyond the
        # previous five-minute interval so all four snapshots are inspected.
        clock = iter([1000, 1000, 2000, 2000, 3000, 3000, 4000, 4000])
        with tempfile.TemporaryDirectory() as directory, self.env(), patch(
            "caratos_connect.runner.source_for", return_value=source
        ), patch("caratos_connect.runner.time.time", side_effect=lambda: next(clock)):
            client = FakeClient(self.PROFILE)
            sync(self.PROFILE, client, Path(directory))
            source.rows = [{"id": "1", "name": "Bina"}]
            sync(self.PROFILE, client, Path(directory))
            source.rows = [{"id": "1", "name": "Asha"}]
            sync(self.PROFILE, client, Path(directory))
            source.rows = [{"id": "1", "name": "Bina"}]
            sync(self.PROFILE, client, Path(directory))

        self.assertEqual(client.uploads, 4)
        self.assertEqual(len(set(client.run_keys)), 4)

    def test_state_file_loss_uses_a_fresh_receipt_and_reapplies_returned_data(self):
        source = FakeSource([{"id": "1", "name": "Asha"}])
        clock = iter([1000, 1000, 2000, 2000, 3000, 3000])
        with tempfile.TemporaryDirectory() as directory, self.env(), patch(
            "caratos_connect.runner.source_for", return_value=source
        ), patch("caratos_connect.runner.time.time", side_effect=lambda: next(clock)):
            state_root = Path(directory)
            client = FakeClient(self.PROFILE)
            sync(self.PROFILE, client, state_root)
            source.rows = [{"id": "1", "name": "Bina"}]
            sync(self.PROFILE, client, state_root)

            # Simulate an unrecoverable local checkpoint loss. The source has
            # returned to A, but its upload must not replay the first A receipt.
            next(state_root.glob("*.json")).unlink()
            source.rows = [{"id": "1", "name": "Asha"}]
            sync(self.PROFILE, client, state_root)

        self.assertEqual(client.uploads, 3)
        self.assertEqual(len(set(client.run_keys)), 3)


if __name__ == "__main__":
    unittest.main()
