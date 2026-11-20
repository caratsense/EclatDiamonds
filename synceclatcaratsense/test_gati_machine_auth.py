import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from gati_machine_auth import (
    AGENT_VERSION,
    GatiAuthError,
    HeartbeatReporter,
    PROFILE_ID,
    PROTOCOL_VERSION,
    approved_connection,
    approved_headers,
    approval_summary,
    profile_hash,
    source_instance_hash,
)
from gati_machine_auth import _optional_json_hash


class Response:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class GatiMachineAuthTests(unittest.TestCase):
    def identity(self, **changes):
        summary = approval_summary(r"SERVER\INSTANCE", "APRSSJEP")
        value = {
            "sourceSystem": "gati",
            "storeId": None,
            "enabled": True,
            "expectedProfileHash": summary["profileHash"],
            "expectedSourceInstanceHash": summary["sourceInstanceHash"],
            "sourceInstanceHash": None,
            "configRevision": "server-generation-2",
            "protocolVersion": PROTOCOL_VERSION,
            "minimumAgentVersion": "0.3.0",
            "maximumAgentVersion": "0.3.999",
        }
        value.update(changes)
        return value

    def test_hashes_are_stable_and_credentials_are_not_inputs(self):
        self.assertRegex(profile_hash(), r"^[a-f0-9]{64}$")
        self.assertEqual(
            source_instance_hash(r" SERVER\INSTANCE ", " APRSSJEP "),
            source_instance_hash(r"server\instance", "aprssjep"),
        )
        self.assertNotEqual(
            source_instance_hash(r"server\instance", "aprssjep"),
            source_instance_hash(r"server\instance", "different"),
        )

    def test_profile_hash_is_bound_to_the_actual_mapper_code(self):
        with patch(
            "gati_machine_auth._mapping_code_hashes",
            return_value={"sync_sjep.py": "a" * 64},
        ):
            first = profile_hash()
        with patch(
            "gati_machine_auth._mapping_code_hashes",
            return_value={"sync_sjep.py": "b" * 64},
        ):
            second = profile_hash()
        self.assertNotEqual(first, second)

    def test_optional_stage_map_is_canonical_and_changes_the_profile_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stage_map.json"
            self.assertEqual(_optional_json_hash(path), "missing")
            path.write_text('{"departmentToStage":{"1":"making"}}', encoding="utf-8")
            first = _optional_json_hash(path)
            path.write_text(
                '{\n  "departmentToStage": { "1": "making" }\n}', encoding="utf-8"
            )
            self.assertEqual(_optional_json_hash(path), first)
            path.write_text('{"departmentToStage":{"1":"qc"}}', encoding="utf-8")
            self.assertNotEqual(_optional_json_hash(path), first)
            path.write_text('{invalid', encoding="utf-8")
            with self.assertRaisesRegex(GatiAuthError, "invalid"):
                _optional_json_hash(path)

    def test_handshake_returns_only_restricted_approval_headers(self):
        session = Mock()
        session.get.return_value = Response(body=self.identity())
        session.post.return_value = Response(body=self.identity())
        headers = approved_headers(
            "https://API.Example.test/",
            "cxa_test-secret",
            r"SERVER\INSTANCE",
            "APRSSJEP",
            session=session,
        )
        self.assertEqual(headers["x-caratos-profile-id"], PROFILE_ID)
        self.assertEqual(headers["x-caratos-config-revision"], "server-generation-2")
        self.assertTrue(re.fullmatch(r"[a-f0-9]{64}", headers["x-caratos-profile-hash"]))
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])
        self.assertFalse(session.post.call_args.kwargs["allow_redirects"])
        self.assertEqual(
            session.post.call_args.kwargs["json"],
            {"status": "active", "agentVersion": AGENT_VERSION},
        )

    def test_heartbeat_policy_is_rechecked_before_headers_are_returned(self):
        session = Mock()
        session.get.return_value = Response(body=self.identity())
        session.post.return_value = Response(
            body=self.identity(configRevision="replacement-generation")
        )
        headers = approved_headers(
            "https://api.example.test",
            "cxa_test-secret",
            r"SERVER\INSTANCE",
            "APRSSJEP",
            session=session,
        )
        self.assertEqual(
            headers["x-caratos-config-revision"], "replacement-generation"
        )

        session.post.return_value = Response(body=self.identity(enabled=False))
        with self.assertRaisesRegex(GatiAuthError, "disabled"):
            approved_headers(
                "https://api.example.test",
                "cxa_test-secret",
                r"SERVER\INSTANCE",
                "APRSSJEP",
                session=session,
            )

    def test_unapproved_disabled_or_store_bound_agent_is_rejected(self):
        cases = (
            ({"enabled": False}, "disabled"),
            ({"storeId": "store-1"}, "organisation-wide"),
            ({"expectedProfileHash": None}, "mapping profile"),
            ({"expectedSourceInstanceHash": None}, "SQL source"),
            ({"configRevision": None}, "configuration generation"),
        )
        for changes, message in cases:
            session = Mock()
            session.get.return_value = Response(body=self.identity(**changes))
            with self.subTest(changes=changes), self.assertRaisesRegex(GatiAuthError, message):
                approved_headers(
                    "https://api.example.test",
                    "cxa_test-secret",
                    r"SERVER\INSTANCE",
                    "APRSSJEP",
                    session=session,
                )

    def test_protocol_and_semver_are_enforced_on_me_and_heartbeat(self):
        cases = (
            ({"protocolVersion": 2}, "protocol"),
            ({"protocolVersion": True}, "protocol"),
            ({"minimumAgentVersion": "0.3.1"}, "outside"),
            (
                {"minimumAgentVersion": "0.1.0", "maximumAgentVersion": "0.2.999"},
                "outside",
            ),
            ({"minimumAgentVersion": "v0.3.0"}, "invalid agent version"),
            (
                {"minimumAgentVersion": "0.4.0", "maximumAgentVersion": "0.3.0"},
                "invalid agent-version range",
            ),
        )
        for changes, message in cases:
            session = Mock()
            session.get.return_value = Response(body=self.identity(**changes))
            with self.subTest(stage="me", changes=changes), self.assertRaisesRegex(
                GatiAuthError, message
            ):
                approved_headers(
                    "https://api.example.test",
                    "cxa_test-secret",
                    r"SERVER\INSTANCE",
                    "APRSSJEP",
                    session=session,
                )

            session = Mock()
            session.get.return_value = Response(body=self.identity())
            session.post.return_value = Response(body=self.identity(**changes))
            with self.subTest(stage="heartbeat", changes=changes), self.assertRaisesRegex(
                GatiAuthError, message
            ):
                approved_headers(
                    "https://api.example.test",
                    "cxa_test-secret",
                    r"SERVER\INSTANCE",
                    "APRSSJEP",
                    session=session,
                )

    def test_reporter_throttles_periodic_beats_and_forces_terminal_success(self):
        now = [10.0]
        session = Mock()
        session.get.return_value = Response(body=self.identity())
        session.post.return_value = Response(body=self.identity())
        headers, reporter = approved_connection(
            "https://api.example.test",
            "cxa_test-secret",
            r"SERVER\INSTANCE",
            "APRSSJEP",
            session=session,
            interval_seconds=60,
            clock=lambda: now[0],
        )
        self.assertIsInstance(reporter, HeartbeatReporter)
        self.assertFalse(reporter.periodic({"phase": "extracting"}))
        now[0] += 61
        session.post.return_value = Response(body=self.identity())
        self.assertTrue(reporter.periodic({"phase": "uploading", "rowsRead": 12}))
        reporter.success({"phase": "complete", "rowsRead": 12})

        self.assertEqual(session.post.call_count, 3)
        periodic = session.post.call_args_list[1].kwargs["json"]
        terminal = session.post.call_args_list[2].kwargs["json"]
        self.assertEqual(periodic["status"], "active")
        self.assertEqual(periodic["stats"]["rowsRead"], 12)
        self.assertEqual(terminal["status"], "active")
        self.assertRegex(terminal["syncedAt"], r"^\d{4}-\d{2}-\d{2}T.*Z$")
        self.assertEqual(headers["x-caratos-config-revision"], "server-generation-2")

    def test_reporter_refuses_to_switch_configuration_generation_mid_cycle(self):
        now = [10.0]
        session = Mock()
        session.get.return_value = Response(body=self.identity())
        session.post.return_value = Response(body=self.identity())
        headers, reporter = approved_connection(
            "https://api.example.test",
            "cxa_test-secret",
            r"SERVER\INSTANCE",
            "APRSSJEP",
            session=session,
            interval_seconds=60,
            clock=lambda: now[0],
        )

        now[0] += 61
        session.post.return_value = Response(
            body=self.identity(configRevision="replacement-generation")
        )
        with self.assertRaisesRegex(GatiAuthError, "changed.*configuration"):
            reporter.periodic({"phase": "uploading"})

        self.assertEqual(headers["x-caratos-config-revision"], "server-generation-2")

        # Once a mixed-generation cycle has been detected it stays poisoned,
        # even if a later response would switch back to the original revision.
        # No further network call or upload may resume in this process.
        calls_after_change = session.post.call_count
        session.post.return_value = Response(body=self.identity())
        now[0] += 61
        with self.assertRaisesRegex(GatiAuthError, "changed.*configuration"):
            reporter.periodic({"phase": "uploading"})
        self.assertEqual(session.post.call_count, calls_after_change)

    def test_terminal_error_is_redacted_bounded_and_revalidates_policy(self):
        session = Mock()
        session.get.return_value = Response(body=self.identity())
        session.post.return_value = Response(body=self.identity())
        _, reporter = approved_connection(
            "https://api.example.test",
            "cxa_test-secret",
            r"SERVER\INSTANCE",
            "APRSSJEP",
            session=session,
        )
        reporter.error(
            RuntimeError(
                "PWD={shop secret}; token=cxa_test-secret; " + "x" * 800
            ),
            {"phase": "failed", "token": "do-not-send"},
        )
        payload = session.post.call_args.kwargs["json"]
        self.assertEqual(payload["status"], "error")
        self.assertLessEqual(len(payload["error"]), 500)
        self.assertNotIn("shop secret", payload["error"])
        self.assertNotIn("cxa_test-secret", payload["error"])
        self.assertNotIn("token", payload.get("stats", {}))

        session.post.return_value = Response(body=self.identity(enabled=False))
        with self.assertRaisesRegex(GatiAuthError, "disabled"):
            reporter.success({"phase": "complete"})

    def test_public_http_and_redirects_are_rejected(self):
        with self.assertRaisesRegex(GatiAuthError, "HTTPS"):
            approved_headers(
                "http://api.example.test", "cxa_test", r"SERVER\INSTANCE", "APRSSJEP"
            )
        session = Mock()
        session.get.return_value = Response(status=302)
        with self.assertRaisesRegex(GatiAuthError, "redirect"):
            approved_headers(
                "https://api.example.test",
                "cxa_test",
                r"SERVER\INSTANCE",
                "APRSSJEP",
                session=session,
            )


if __name__ == "__main__":
    unittest.main()
