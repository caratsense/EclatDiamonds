import json
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests

from caratos_connect.client import CaratOSClient, MAX_UPLOAD_BYTES, _payload, csv_bytes
from caratos_connect.cli import _doctor, _safe_error, _should_send_error_heartbeat, _sync_exit_code
from caratos_connect.mapping import map_rows, map_rows_detailed
from caratos_connect.profile import (
    ProfileError,
    _split_odbc_connection,
    load_profile,
    profile_fingerprint,
    safe_select,
    source_instance_fingerprint,
    validate_profile,
)
from caratos_connect.runner import preview as local_preview, sync
from caratos_connect.secret_store import (
    load_into_environment,
    load_secret_store,
    save_secret_store,
)
from caratos_connect.sources import (
    OdbcSource,
    SourceError,
    SourceLimitExceeded,
    _build_access_connection_string,
    build_tally_request,
    parse_tally_records,
)
from caratos_connect.state import (
    AlreadyRunningError,
    StateError,
    load_state,
    rows_fingerprint,
    state_lock,
)


ROOT = Path(__file__).resolve().parents[1]


class ProfileTests(unittest.TestCase):
    def test_shipped_profiles_validate(self):
        for path in (ROOT / "profiles").glob("*.json"):
            profile = load_profile(path)
            self.assertEqual(profile["schemaVersion"], 1, path.name)

    def test_tally_starter_never_falls_back_to_mutable_identity_fields(self):
        profile = load_profile(ROOT / "profiles" / "tally-prime-starter.json")
        self.assertEqual(profile["entities"]["customers"]["fields"]["code"], ["GUID"])
        self.assertEqual(profile["entities"]["products"]["fields"]["sku"], ["GUID"])

    def test_sql_profiles_fail_closed_on_write_or_second_statement(self):
        for query in (
            "UPDATE Customer SET name='x'",
            "SELECT * FROM Customer; DELETE FROM Customer",
            "SELECT * INTO Copy FROM Customer",
            "SELECT * FROM Customer -- ignore",
        ):
            with self.subTest(query=query), self.assertRaises(ProfileError):
                safe_select(query)
        self.assertEqual(safe_select("SELECT * FROM Customer;"), "SELECT * FROM Customer")

    def test_profile_requires_stable_namespaced_canonical_identity(self):
        with self.assertRaisesRegex(ProfileError, "missing required mappings"):
            validate_profile(
                {
                    "schemaVersion": 1,
                    "id": "broken-profile",
                    "sourceSystem": "odbc",
                    "transport": {"kind": "odbc"},
                    "entities": {
                        "customers": {
                            "query": "SELECT id FROM x",
                            "fields": {"name": "name"},
                            "prefixValues": {},
                        }
                    },
                }
            )
        with self.assertRaisesRegex(ProfileError, "prefixValues.code"):
            validate_profile(
                {
                    "schemaVersion": 1,
                    "id": "broken-prefix",
                    "sourceSystem": "odbc",
                    "transport": {"kind": "odbc"},
                    "entities": {
                        "customers": {
                            "query": "SELECT id, name FROM x",
                            "fields": {"code": "id", "name": "name"},
                            "prefixValues": {},
                        }
                    },
                }
            )

    def test_profile_rejects_unknown_fields_filters_and_transport_mismatch(self):
        base = {
            "schemaVersion": 1,
            "id": "strict-profile",
            "sourceSystem": "tally",
            "transport": {"kind": "odbc"},
            "entities": {},
            "discoveryOnly": True,
        }
        with self.assertRaisesRegex(ProfileError, "cannot use"):
            validate_profile(base)

        base.update(
            {
                "sourceSystem": "odbc",
                "entities": {
                    "customers": {
                        "query": "SELECT id, name FROM x",
                        "fields": {"code": "id", "name": "name", "secret": "password"},
                        "prefixValues": {"code": "x:"},
                    }
                },
            }
        )
        with self.assertRaisesRegex(ProfileError, "unknown canonical"):
            validate_profile(base)

    def test_profile_hash_ignores_local_path(self):
        profile = load_profile(ROOT / "profiles" / "busy-bds-starter.json")
        first = profile_fingerprint(profile)
        profile["_path"] = "somewhere-else"
        self.assertEqual(profile_fingerprint(profile), first)

    def test_scalar_filter_is_normalized_instead_of_matching_everything(self):
        profile = validate_profile(
            {
                "schemaVersion": 1,
                "id": "normalized-filter",
                "sourceSystem": "odbc",
                "transport": {"kind": "odbc"},
                "entities": {
                    "customers": {
                        "query": "SELECT id, name, kind FROM customers",
                        "fields": {"code": "id", "name": "name", "_kind": "kind"},
                        "prefixValues": {"code": "odbc:"},
                        "include": [{"field": "_kind", "equalsAny": "customer"}],
                    }
                },
            }
        )
        definition = profile["entities"]["customers"]
        rows, _issues, filtered = map_rows_detailed(
            definition,
            [
                {"id": "1", "name": "Allowed", "kind": "customer"},
                {"id": "2", "name": "Blocked", "kind": "supplier"},
            ],
        )
        self.assertEqual([row["name"] for row in rows], ["Allowed"])
        self.assertEqual(filtered, 1)


class MappingTests(unittest.TestCase):
    def test_candidates_filter_hidden_fields_and_namespace_ids(self):
        definition = {
            "fields": {
                "code": ["guid", "id"],
                "name": ["ledgername", "name"],
                "phone": ["mobile"],
                "_parent": ["parent"],
            },
            "prefixValues": {"code": "tally:"},
            "include": [{"field": "_parent", "containsAny": ["sundry debtors"]}],
        }
        rows, issues, filtered = map_rows_detailed(
            definition,
            [
                {"GUID": "abc", "LedgerName": "Asha", "Mobile": "999", "Parent": "Sundry Debtors"},
                {"GUID": "bank", "LedgerName": "Bank", "Parent": "Bank Accounts"},
            ],
        )
        self.assertEqual(issues, [])
        self.assertEqual(filtered, 1)
        self.assertEqual(rows, [{"code": "tally:abc", "name": "Asha", "phone": "999"}])

    def test_missing_required_row_is_reported_not_silently_dropped(self):
        rows, issues = map_rows({"fields": {"name": ["name"]}}, [{"id": 1}])
        self.assertEqual(rows, [])
        self.assertEqual(issues[0]["code"], "missing_required")

    def test_customer_source_code_is_required_per_row(self):
        rows, issues = map_rows(
            {
                "fields": {"code": ["id"], "name": ["name"]},
                "prefixValues": {"code": "busy:"},
            },
            [{"id": "", "name": "No stable identity"}],
        )
        self.assertEqual(rows, [])
        self.assertEqual(issues[0]["fields"], ["code"])


class TallyXmlTests(unittest.TestCase):
    PAYLOAD = b"""<ENVELOPE><BODY><DATA><COLLECTION>
      <LEDGER NAME="Asha Traders"><GUID>g1</GUID><PARENT>Sundry Debtors</PARENT></LEDGER>
      <LEDGER><GUID>g2</GUID><NAME>Second</NAME><PARENT>Sundry Debtors</PARENT></LEDGER>
    </COLLECTION></DATA></BODY></ENVELOPE>"""

    def test_request_and_response_fixture(self):
        definition = {
            "objectType": "Ledger",
            "recordTags": ["LEDGER"],
            "fields": {"code": ["GUID"], "name": ["NAME"], "_parent": ["PARENT"]},
        }
        request = build_tally_request(definition, "Demo & Co")
        self.assertIn(b"SVCURRENTCOMPANY", request)
        self.assertIn(b"Demo &amp; Co", request)
        rows = parse_tally_records(self.PAYLOAD, ["LEDGER"], 2)
        self.assertEqual(rows[0], {"GUID": "g1", "NAME": "Asha Traders", "PARENT": "Sundry Debtors"})

    def test_overflow_and_tally_error_fail_closed(self):
        with self.assertRaises(SourceLimitExceeded):
            parse_tally_records(self.PAYLOAD, ["LEDGER"], 1)
        with self.assertRaisesRegex(SourceError, "rejected"):
            parse_tally_records(b"<ENVELOPE><LINEERROR>Company is invalid</LINEERROR></ENVELOPE>", ["LEDGER"], 5)
        with self.assertRaisesRegex(SourceError, "failed export"):
            parse_tally_records(b"<ENVELOPE><STATUS>0</STATUS></ENVELOPE>", ["LEDGER"], 5)


class FakeSource:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def extract(self, _definition, limit, detect_overflow=True):
        self.limit = limit
        if detect_overflow and len(self.rows) > limit:
            raise SourceLimitExceeded("fixture overflow")
        return self.rows[:limit]


class FakeClient:
    def __init__(self, failed=0, duplicate=0, server_error=0, profile=None):
        self.failed = failed
        self.duplicate = duplicate
        self.uploads = 0
        self.validations = 0
        self.heartbeats = 0
        self.server_error = server_error
        self.last_rows = []
        self.profile = profile

    def me(self, expected_source):
        return {
            "agentId": "agent-1",
            "organisationId": "org-1",
            "sourceSystem": expected_source,
            "storeId": None,
            "protocolVersion": 1,
            "minimumAgentVersion": "0.3.0",
            "maximumAgentVersion": "0.3.999",
            "enabled": True,
            "configRevision": "server-generation-1",
            "expectedProfileHash": (
                profile_fingerprint(self.profile) if self.profile is not None else None
            ),
            "expectedSourceInstanceHash": (
                source_instance_fingerprint(self.profile)
                if self.profile is not None and os.environ.get("CONNECT_SOURCE_DSN")
                else None
            ),
        }

    def validate(
        self,
        _source,
        _profile,
        _entity,
        rows,
        _store,
        _profile_hash,
        _source_instance_hash,
    ):
        self.validations += 1
        return {
            "total": len(rows),
            "valid": len(rows) - self.server_error,
            "warning": 0,
            "error": self.server_error,
        }

    def upload(
        self,
        _source,
        _profile,
        _entity,
        rows,
        _store,
        _run_key,
        _profile_hash,
        _source_instance_hash,
        _config_revision,
    ):
        self.uploads += 1
        self.last_rows = [dict(row) for row in rows]
        imported = len(rows) if not self.failed and not self.duplicate else 0
        return {
            "counts": {
                "discovered": len(rows),
                "imported": imported,
                "updated": 0,
                "skipped": 0,
                "duplicate": self.duplicate,
                "failed": self.failed,
            }
        }

    def heartbeat(self, *_args, **_kwargs):
        self.heartbeats += 1
        return {"enabled": True}


class RunnerTests(unittest.TestCase):
    PROFILE = {
        "schemaVersion": 1,
        "id": "test-profile",
        "sourceSystem": "busy",
        "transport": {"kind": "odbc", "connectionEnv": "CONNECT_SOURCE_DSN"},
        "entities": {
            "customers": {
                "fields": {"code": ["id"], "name": ["name"]},
                "prefixValues": {"code": "busy:"},
            }
        },
    }

    def test_state_advances_only_after_acceptance_and_unchanged_data_skips(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ):
            state_root = Path(directory)
            with patch("caratos_connect.runner.source_for", return_value=FakeSource([{"id": "1", "name": "Asha"}])):
                failing = FakeClient(failed=1, profile=self.PROFILE)
                with self.assertRaisesRegex(RuntimeError, "state not advanced"):
                    sync(self.PROFILE, failing, state_root)
                checkpoints = list(state_root.glob("*.json"))
                self.assertEqual(len(checkpoints), 1)
                pending = json.loads(checkpoints[0].read_text(encoding="utf-8"))
                self.assertTrue(any('"attemptId"' in value for value in pending.values()))

                client = FakeClient(profile=self.PROFILE)
                sync(self.PROFILE, client, state_root)
                self.assertEqual(len(list(state_root.glob("*.json"))), 1)
                self.assertEqual(client.uploads, 1)
                scheduled = sync(self.PROFILE, client, state_root)
                self.assertEqual(client.uploads, 1)
                self.assertEqual(client.validations, 1)
                self.assertEqual(scheduled["phase"], "not_due")

    def test_dry_run_uses_backend_validation_and_never_advances_state(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ):
            state_root = Path(directory)
            client = FakeClient()
            with patch("caratos_connect.runner.source_for", return_value=FakeSource([{"id": "1", "name": "Asha"}])):
                result = sync(self.PROFILE, client, state_root, dry_run=True)
            self.assertEqual(result["rowsReady"], 1)
            self.assertEqual(result["rowsServerValid"], 1)
            self.assertEqual(client.validations, 1)
            self.assertEqual(client.uploads, 0)
            self.assertEqual(client.heartbeats, 0)
            self.assertEqual(list(state_root.glob("*.json")), [])

    def test_disabled_or_wrong_profile_refuses_before_source_access(self):
        identity = FakeClient(profile=self.PROFILE).me("busy")
        identity["enabled"] = False
        client = FakeClient(profile=self.PROFILE)
        with patch("caratos_connect.runner.source_for") as source:
            result = sync(self.PROFILE, client, Path("unused"), identity=identity)
        self.assertTrue(result["disabled"])
        source.assert_not_called()

        with patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ):
            pinned = FakeClient(profile=self.PROFILE).me("busy")
            pinned["sourceInstanceHash"] = "f" * 64
            with patch("caratos_connect.runner.source_for") as source, self.assertRaisesRegex(
                RuntimeError, "different source connection descriptor"
            ):
                sync(self.PROFILE, client, Path("unused"), identity=pinned)
        source.assert_not_called()

        identity["enabled"] = True
        identity["expectedProfileHash"] = "0" * 64
        with patch("caratos_connect.runner.source_for") as source, self.assertRaisesRegex(
            RuntimeError, "approved profile hash"
        ):
            sync(self.PROFILE, client, Path("unused"), identity=identity)
        source.assert_not_called()

    def test_live_sync_validates_and_binds_sorted_ids_to_the_source_instance(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ):
            client = FakeClient(profile=self.PROFILE)
            with patch(
                "caratos_connect.runner.source_for",
                return_value=FakeSource(
                    [{"id": "2", "name": "Zulu"}, {"id": "1", "name": "Alpha"}]
                ),
            ):
                sync(self.PROFILE, client, Path(directory))
            namespace = source_instance_fingerprint(self.PROFILE)[:32]
        self.assertEqual(client.validations, 1)
        self.assertEqual(client.uploads, 1)
        self.assertEqual(
            [row["code"] for row in client.last_rows],
            [f"busy:{namespace}:1", f"busy:{namespace}:2"],
        )

    def test_server_validation_error_blocks_live_upload_and_state(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ):
            state_root = Path(directory)
            client = FakeClient(server_error=1, profile=self.PROFILE)
            with patch(
                "caratos_connect.runner.source_for",
                return_value=FakeSource([{"id": "1", "name": "Rejected"}]),
            ), self.assertRaisesRegex(RuntimeError, "server validation rejected"):
                sync(self.PROFILE, client, state_root)
            self.assertEqual(client.uploads, 0)
            self.assertEqual(list(state_root.glob("*.json")), [])

    def test_local_preview_needs_no_server_identity_and_discovery_profiles_cannot_sync(self):
        with patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ), patch(
            "caratos_connect.runner.source_for",
            return_value=FakeSource([{"id": "1", "name": "Preview"}]),
        ):
            result = local_preview(self.PROFILE, show_values=True)
        self.assertEqual(result["entities"]["customers"]["sample"][0]["code"], "busy:1")

        sample_source = FakeSource(
            [{"id": str(index), "name": f"Row {index}"} for index in range(21)]
        )
        with patch.dict(
            os.environ, {"CONNECT_SOURCE_DSN": "server=test;database=one;pwd=secret"}
        ), patch("caratos_connect.runner.source_for", return_value=sample_source):
            sampled = local_preview(self.PROFILE, limit=20, show_values=True)
        self.assertEqual(sample_source.limit, 20)
        self.assertEqual(sampled["entities"]["customers"]["read"], 20)
        self.assertEqual(sampled["entities"]["customers"]["ready"], 20)

        client = Mock()
        with patch("caratos_connect.runner.source_for") as source, self.assertRaisesRegex(
            RuntimeError, "discovery-only"
        ):
            sync(
                {
                    "schemaVersion": 1,
                    "id": "discovery-only",
                    "sourceSystem": "odbc",
                    "transport": {"kind": "odbc"},
                    "discoveryOnly": True,
                    "entities": {},
                },
                client,
                Path("unused"),
            )
        client.me.assert_not_called()
        source.assert_not_called()


class StateTests(unittest.TestCase):
    def test_fingerprint_is_order_independent_and_corrupt_state_refuses(self):
        rows = [{"code": "2", "name": "B"}, {"code": "1", "name": "A"}]
        self.assertEqual(rows_fingerprint(rows), rows_fingerprint(list(reversed(rows))))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(StateError):
                load_state(path)

    def test_second_process_lock_attempt_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            with state_lock(path):
                with self.assertRaises(AlreadyRunningError):
                    with state_lock(path):
                        pass


class SourceSafetyTests(unittest.TestCase):
    def test_access_odbc_values_are_braced_and_cannot_inject_mode_or_dbq(self):
        connection = _build_access_connection_string(
            "Access} Driver",
            Path("client};Mode=Write;DBQ=attacker.bds"),
            "hunter};Mode=Write",
        )
        attributes = [part for part in _split_odbc_connection(connection) if part]

        self.assertEqual(len(attributes), 4)
        self.assertEqual(attributes[2], "Mode=Read")
        self.assertTrue(attributes[0].startswith("Driver={Access}} Driver}"))
        self.assertTrue(attributes[1].startswith("DBQ={client}};Mode=Write;DBQ="))
        self.assertTrue(attributes[3].startswith("PWD={hunter}};Mode=Write}"))

    def test_access_odbc_values_reject_control_characters(self):
        cases = (
            ("Access\x00Driver", Path("client.bds"), ""),
            ("Access Driver", Path("client\ncopy.bds"), ""),
            ("Access Driver", Path("client.bds"), "secret\tvalue"),
        )
        for driver, database, password in cases:
            with self.subTest(driver=driver, database=database), self.assertRaisesRegex(
                SourceError, "control character"
            ):
                _build_access_connection_string(driver, database, password)

    def test_access_copy_is_removed_when_connection_fails_and_no_unrestricted_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "client.bds"
            source.write_bytes(b"client data")
            fake_connect = Mock(side_effect=TypeError("readonly unsupported"))
            fake_pyodbc = SimpleNamespace(connect=fake_connect)
            before = set(Path(tempfile.gettempdir()).glob("caratos-connect-*"))
            profile = {
                "transport": {
                    "kind": "access_file",
                    "pathEnv": "CONNECT_SOURCE_FILE",
                    "passwordEnv": "CONNECT_SOURCE_PASSWORD",
                }
            }
            with patch.dict(sys.modules, {"pyodbc": fake_pyodbc}), patch.dict(
                os.environ,
                {"CONNECT_SOURCE_FILE": str(source), "CONNECT_SOURCE_PASSWORD": "secret"},
            ):
                with self.assertRaises(TypeError):
                    with OdbcSource(profile):
                        pass
            self.assertEqual(fake_connect.call_count, 1)
            self.assertEqual(set(Path(tempfile.gettempdir()).glob("caratos-connect-*")), before)

    def test_access_copy_refuses_if_source_changes_during_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "client.bds"
            source.write_bytes(b"initial database")
            fake_connect = Mock()
            fake_pyodbc = SimpleNamespace(connect=fake_connect)
            real_copy = __import__("shutil").copy2

            def changing_copy(source_path, target_path):
                result = real_copy(source_path, target_path)
                Path(source_path).write_bytes(b"database changed during copy")
                return result

            profile = {
                "transport": {
                    "kind": "access_file",
                    "pathEnv": "CONNECT_SOURCE_FILE",
                    "passwordEnv": "CONNECT_SOURCE_PASSWORD",
                }
            }
            before = set(Path(tempfile.gettempdir()).glob("caratos-connect-*"))
            with patch.dict(sys.modules, {"pyodbc": fake_pyodbc}), patch.dict(
                os.environ, {"CONNECT_SOURCE_FILE": str(source)}
            ), patch("caratos_connect.sources.shutil.copy2", side_effect=changing_copy):
                with self.assertRaisesRegex(SourceError, "changed during the safe copy"):
                    with OdbcSource(profile):
                        pass
            fake_connect.assert_not_called()
            self.assertEqual(set(Path(tempfile.gettempdir()).glob("caratos-connect-*")), before)

    def test_odbc_cursor_has_a_query_timeout(self):
        cursor = SimpleNamespace(timeout=0)
        source = OdbcSource({"transport": {"kind": "odbc"}})
        source.connection = SimpleNamespace(cursor=Mock(return_value=cursor))
        self.assertIs(source._cursor(), cursor)
        self.assertEqual(cursor.timeout, 60)


class ClientTests(unittest.TestCase):
    @staticmethod
    def response(status: int, body: dict | None = None, headers: dict | None = None):
        response = requests.Response()
        response.status_code = status
        response.headers.update(headers or {})
        response._content = json.dumps(body or {}).encode()
        response.url = "https://api.example.test/test"
        return response

    def test_transient_response_retries_but_normal_4xx_does_not(self):
        client = CaratOSClient("https://api.example.test", "cxa_secret")
        client.session.request = Mock(
            side_effect=[
                self.response(503, headers={"Retry-After": "0"}),
                self.response(
                    200,
                    {
                        "sourceSystem": "busy",
                        "protocolVersion": 1,
                    },
                ),
            ]
        )
        with patch("caratos_connect.client.time.sleep"):
            self.assertEqual(client.me("busy")["sourceSystem"], "busy")
        self.assertEqual(client.session.request.call_count, 2)

        client.session.request = Mock(return_value=self.response(400))
        with self.assertRaises(requests.HTTPError):
            client.me("busy")
        self.assertEqual(client.session.request.call_count, 1)

    def test_oversized_upload_refuses_before_network(self):
        client = CaratOSClient("https://api.example.test", "cxa_secret")
        client.session.request = Mock()
        with self.assertRaisesRegex(RuntimeError, "7 MiB"):
            client.upload(
                "busy",
                "profile",
                "customers",
                [{"code": "busy:1", "name": "x" * (MAX_UPLOAD_BYTES + 1)}],
                None,
                "a" * 64,
                "b" * 64,
                "c" * 64,
                "server-generation-1",
            )
        client.session.request.assert_not_called()


class CsvTests(unittest.TestCase):
    def test_doctor_fails_when_access_driver_is_not_visible_to_python(self):
        profile = {
            "id": "busy-test",
            "sourceSystem": "busy",
            "transport": {"kind": "access_file", "driver": "Expected Access Driver"},
        }
        with patch.dict(sys.modules, {"pyodbc": SimpleNamespace(drivers=lambda: ["Other Driver"])}):
            with self.assertRaisesRegex(RuntimeError, "required ODBC driver is not visible"):
                _doctor(profile)

        with patch.dict(
            sys.modules, {"pyodbc": SimpleNamespace(drivers=lambda: ["Expected Access Driver"])}
        ):
            result = _doctor(profile)
        self.assertEqual(result["requiredOdbcDriver"], "Expected Access Driver")
        self.assertFalse(result["sourceAccessed"])

    def test_installer_exit_code_refuses_a_disabled_policy(self):
        self.assertEqual(_sync_exit_code({"phase": "disabled"}), 0)
        self.assertEqual(_sync_exit_code({"phase": "disabled"}, require_active=True), 4)
        self.assertEqual(_sync_exit_code({"phase": "complete"}, require_active=True), 0)

    def test_validation_only_dry_run_never_reports_error_heartbeat(self):
        self.assertFalse(
            _should_send_error_heartbeat(SimpleNamespace(command="sync", dry_run=True))
        )
        self.assertTrue(
            _should_send_error_heartbeat(SimpleNamespace(command="sync", dry_run=False))
        )

    def test_csv_uses_canonical_headers(self):
        value = csv_bytes(["name", "phone"], [{"name": "Asha", "phone": "999"}]).decode("utf-8-sig")
        self.assertEqual(value.splitlines()[0], "name,phone")

    def test_payload_bytes_are_stable_across_row_and_field_order(self):
        left = [{"name": "Beta", "code": "2"}, {"code": "1", "name": "Alpha"}]
        right = [{"name": "Alpha", "code": "1"}, {"code": "2", "name": "Beta"}]
        left.sort(key=lambda row: json.dumps(row, sort_keys=True))
        right.sort(key=lambda row: json.dumps(row, sort_keys=True))
        self.assertEqual(_payload(left), _payload(right))

    def test_errors_redact_tokens_custom_connections_and_uri_credentials(self):
        value = _safe_error(
            RuntimeError(
                "cxa_secret failed; PWD={hunter;two}; token=other "
                "ClientSecret={client;secret}; APIKey=api-value; "
                "SSLKey={ssl}}key;tail}; AccessKey=access-value; "
                "SecretAccessKey={secret;access}; "
                "https://me:uri-pass@example.test"
            ),
            "cxa_secret",
        )
        for secret in (
            "cxa_secret",
            "hunter;two",
            "other",
            "client;secret",
            "api-value",
            "ssl}}key;tail",
            "access-value",
            "secret;access",
            "me:uri-pass",
        ):
            self.assertNotIn(secret, value)

    @unittest.skipUnless(os.name == "nt", "production credential storage uses Windows DPAPI")
    def test_dpapi_store_round_trips_without_plaintext(self):
        values = {
            "CARATOS_BASE_URL": "https://api.example.test",
            "CARATOS_AGENT_TOKEN": "cxa_roundtrip_secret",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credentials.bin"
            save_secret_store(path, values)
            self.assertEqual(load_secret_store(path), values)
            self.assertNotIn(b"cxa_roundtrip_secret", path.read_bytes())
            with patch.dict(
                os.environ,
                {
                    "CARATOS_BASE_URL": "https://stale.example.test",
                    "CARATOS_AGENT_TOKEN": "cxa_stale_plaintext",
                },
            ):
                load_into_environment(path, values.keys())
                self.assertEqual(os.environ["CARATOS_AGENT_TOKEN"], "cxa_roundtrip_secret")


if __name__ == "__main__":
    unittest.main()
