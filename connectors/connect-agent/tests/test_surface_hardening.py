import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from caratos_connect.client import CaratOSClient
from caratos_connect.profile import (
    ProfileError,
    source_instance_fingerprint,
    validate_profile,
)
from caratos_connect.sources import SourceError, TallyXmlSource, _assert_tally_url


ROOT = Path(__file__).resolve().parents[1]


def odbc_profile() -> dict:
    return {
        "schemaVersion": 1,
        "id": "surface-hardening",
        "sourceSystem": "odbc",
        "transport": {"kind": "odbc", "connectionEnv": "CONNECT_SOURCE_DSN"},
        "entities": {
            "customers": {
                "query": "SELECT id, name, kind FROM customers",
                "fields": {"code": ["id"], "name": ["name"], "_kind": ["kind"]},
                "prefixValues": {"code": "odbc:"},
                "include": [{"field": "_kind", "equalsAny": ["customer"]}],
            }
        },
    }


class RuntimeProfileStrictnessTests(unittest.TestCase):
    def test_unknown_keys_fail_closed_at_every_profile_level(self):
        cases = []

        root = odbc_profile()
        root["unexpected"] = True
        cases.append((root, "profile has unsupported keys"))

        transport = odbc_profile()
        transport["transport"]["timeout"] = 30
        cases.append((transport, "transport has unsupported keys"))

        entity = odbc_profile()
        entity["entities"]["customers"]["transform"] = "unsafe"
        cases.append((entity, "entities.customers has unsupported keys"))

        filter_rule = odbc_profile()
        filter_rule["entities"]["customers"]["include"][0]["ignoreCase"] = True
        cases.append((filter_rule, "include\\[0\\] has unsupported keys"))

        for raw, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ProfileError, message):
                validate_profile(raw)

    def test_environment_variable_names_are_strict(self):
        for value in ("connect_source_dsn", "1CONNECT_SOURCE", "BAD-NAME", 123):
            raw = odbc_profile()
            raw["transport"]["connectionEnv"] = value
            with self.subTest(value=value), self.assertRaisesRegex(
                ProfileError, "uppercase environment variable name"
            ):
                validate_profile(raw)

    def test_field_and_filter_candidates_must_be_strings(self):
        raw = odbc_profile()
        raw["entities"]["customers"]["fields"]["code"] = ["id", 7]
        with self.assertRaisesRegex(ProfileError, "contain only strings"):
            validate_profile(raw)

        raw = odbc_profile()
        raw["entities"]["customers"]["include"][0]["equalsAny"] = ["customer", False]
        with self.assertRaisesRegex(ProfileError, "contain only strings"):
            validate_profile(raw)

    def test_allow_empty_is_an_explicit_boolean_in_runtime_and_schema(self):
        for allowed in (False, True):
            raw = odbc_profile()
            raw["entities"]["customers"]["allowEmpty"] = allowed
            self.assertIs(validate_profile(raw)["entities"]["customers"]["allowEmpty"], allowed)

        for invalid in (0, 1, "true", None):
            raw = odbc_profile()
            raw["entities"]["customers"]["allowEmpty"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ProfileError, "allowEmpty must be a boolean"
            ):
                validate_profile(raw)

        schema = json.loads((ROOT / "profile.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["$defs"]["entity"]["properties"]["allowEmpty"], {"type": "boolean"})


class OriginUrlSafetyTests(unittest.TestCase):
    def test_tally_url_rejects_non_origin_and_invalid_port_forms(self):
        invalid = (
            "ftp://localhost:9000",
            "http://user:password@127.0.0.1:9000",
            "http://127.0.0.1:9000/export",
            "http://127.0.0.1:9000?company=x",
            "http://127.0.0.1:9000?",
            "http://127.0.0.1:9000#fragment",
            "http://127.0.0.1:9000#",
            "http://127.0.0.1:not-a-port",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:0",
            "https://bad;host.example",
            "https://%31%32%37.0.0.1",
        )
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(SourceError):
                _assert_tally_url(url)

    def test_tally_plain_http_stays_local_or_private(self):
        self.assertEqual(_assert_tally_url("HTTP://LOCALHOST:09000/"), "http://localhost:9000")
        self.assertEqual(
            _assert_tally_url("http://192.168.10.20:9000"),
            "http://192.168.10.20:9000",
        )
        with self.assertRaisesRegex(SourceError, "plain HTTP"):
            _assert_tally_url("http://8.8.8.8:9000")
        for unsafe_local in ("169.254.169.254", "0.0.0.0", "192.0.2.1"):
            with self.subTest(unsafe_local=unsafe_local), self.assertRaisesRegex(
                SourceError, "plain HTTP"
            ):
                _assert_tally_url(f"http://{unsafe_local}:9000")

    def test_tally_plain_http_rejects_a_hostname_with_any_public_answer(self):
        answers = [
            (2, 1, 6, "", ("192.168.10.20", 0)),
            (2, 1, 6, "", ("8.8.8.8", 0)),
        ]
        with patch("caratos_connect.sources.socket.getaddrinfo", return_value=answers):
            with self.assertRaisesRegex(SourceError, "plain HTTP"):
                _assert_tally_url("http://tally.internal:9000")

    def test_tally_source_uses_the_normalized_origin(self):
        profile = {"transport": {"kind": "tally_xml"}, "entities": {}}
        with patch.dict(
            os.environ,
            {"TALLY_URL": " HTTP://LOCALHOST:080/ ", "TALLY_COMPANY": "Example"},
        ):
            self.assertEqual(TallyXmlSource(profile).url, "http://localhost")

    def test_caratos_base_url_is_an_https_origin_except_for_loopback(self):
        client = CaratOSClient("HTTPS://API.Example.Test:443/", "cxa_test")
        self.addCleanup(client.session.close)
        self.assertEqual(client.base_url, "https://api.example.test")

        loopback = CaratOSClient("http://127.0.0.2:8080/", "cxa_test")
        self.addCleanup(loopback.session.close)
        self.assertEqual(loopback.base_url, "http://127.0.0.2:8080")

        ipv6_loopback = CaratOSClient("http://[0:0:0:0:0:0:0:1]:80/", "cxa_test")
        self.addCleanup(ipv6_loopback.session.close)
        self.assertEqual(ipv6_loopback.base_url, "http://[::1]")

        invalid = (
            "ftp://localhost",
            "https:///",
            "http://192.168.10.20",
            "http://8.8.8.8",
            "https://user:password@api.example.test",
            "https://api.example.test/connect",
            "https://api.example.test?tenant=x",
            "https://api.example.test?",
            "https://api.example.test#fragment",
            "https://api.example.test#",
            "https://api.example.test:not-a-port",
            "https://api.example.test:65536",
            "https://api.example.test:0",
            "https://api.example.test:",
            "https://bad;host.example",
        )
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                CaratOSClient(url, "cxa_test")

    def test_url_errors_never_echo_user_information(self):
        secret = "do-not-echo-this"
        with self.assertRaises(RuntimeError) as caught:
            CaratOSClient(f"https://operator:{secret}@api.example.test", "cxa_test")
        self.assertNotIn(secret, str(caught.exception))

    def test_authenticated_api_and_tally_posts_never_follow_redirects(self):
        redirect = requests.Response()
        redirect.status_code = 307
        redirect.headers["Location"] = "https://collector.example.test"
        redirect.url = "https://api.example.test/integration/connect/me"

        client = CaratOSClient("https://api.example.test", "cxa_test")
        self.addCleanup(client.session.close)
        client.session.request = Mock(return_value=redirect)
        with self.assertRaisesRegex(RuntimeError, "redirects are not allowed"):
            client.me("odbc")
        self.assertFalse(client.session.request.call_args.kwargs["allow_redirects"])

        profile = {"transport": {"kind": "tally_xml"}, "entities": {}}
        with patch.dict(
            os.environ,
            {"TALLY_URL": "http://127.0.0.1:9000", "TALLY_COMPANY": "Example"},
        ):
            source = TallyXmlSource(profile)
        tally_redirect = requests.Response()
        tally_redirect.status_code = 308
        tally_redirect.headers["Location"] = "http://collector.example.test"
        tally_redirect.url = source.url
        tally_redirect.raw = Mock()
        with patch(
            "caratos_connect.sources.requests.post", return_value=tally_redirect
        ) as post:
            with self.assertRaisesRegex(SourceError, "redirects are not allowed"):
                source._post(b"<ENVELOPE />")
        self.assertFalse(post.call_args.kwargs["allow_redirects"])


class SourceInstanceIdentityTests(unittest.TestCase):
    ODBC_PROFILE = {
        "transport": {"kind": "odbc", "connectionEnv": "CONNECT_SOURCE_DSN"}
    }
    TALLY_PROFILE = {
        "transport": {
            "kind": "tally_xml",
            "urlEnv": "TALLY_URL",
            "companyEnv": "TALLY_COMPANY",
        }
    }

    def odbc_fingerprint(self, connection: str) -> str:
        with patch.dict(os.environ, {"CONNECT_SOURCE_DSN": connection}):
            return source_instance_fingerprint(self.ODBC_PROFILE)

    def test_equivalent_odbc_strings_share_identity_and_drop_credentials(self):
        first = (
            " Driver = {ODBC Driver 18 for SQL Server} ; SERVER = db.example.test ; "
            "Database = Jewellery ; UID = first-user ; PWD = {hunter;two} ; Encrypt = yes ; "
            "Jet OLEDB:Database Password = deep-secret ; SSLKey = private-key-one ; "
            "ClientSecret={client;secret-one};APIKey=api-one;AccessKey=access-one;"
        )
        second = (
            "encrypt=yes;password={different;secret};database=Jewellery;"
            "user id=second-user;server=db.example.test;"
            "driver=ODBC Driver 18 for SQL Server;"
            "jet oledb:database password=another-deep-secret;sslkey=private-key-two;"
            "client_secret={client;secret-two};api_key=api-two;access_key=access-two"
        )
        self.assertEqual(self.odbc_fingerprint(first), self.odbc_fingerprint(second))

        captured = []
        real_sha256 = hashlib.sha256

        def capture(value: bytes):
            captured.append(value)
            return real_sha256(value)

        with patch("caratos_connect.profile.hashlib.sha256", side_effect=capture):
            self.odbc_fingerprint(first)
        descriptor = b"".join(captured)
        for credential in (
            b"first-user",
            b"hunter",
            b"two",
            b"deep-secret",
            b"private-key-one",
            b"client;secret-one",
            b"api-one",
            b"access-one",
        ):
            self.assertNotIn(credential, descriptor)

    def test_unknown_non_secret_odbc_selectors_are_part_of_source_identity(self):
        base = (
            "Driver=SQL Server;Server=alpha;Database=main;"
            "CurrentSchema=public;ApplicationIntent=ReadOnly;UID=user;PWD=secret"
        )
        other_schema = base.replace("CurrentSchema=public", "CurrentSchema=archive")
        other_intent = base.replace("ApplicationIntent=ReadOnly", "ApplicationIntent=ReadWrite")

        self.assertNotEqual(self.odbc_fingerprint(base), self.odbc_fingerprint(other_schema))
        self.assertNotEqual(self.odbc_fingerprint(base), self.odbc_fingerprint(other_intent))

    def test_duplicate_odbc_source_keys_are_ambiguous(self):
        with self.assertRaisesRegex(ProfileError, "duplicate 'server'"):
            self.odbc_fingerprint("Server=alpha;SERVER=beta;Database=main")
        with self.assertRaisesRegex(ProfileError, "duplicate 'server'"):
            self.odbc_fingerprint("Address=alpha;Server=beta;Database=main")

    def test_odbc_server_and_database_changes_get_distinct_identities(self):
        base = "Driver=SQL Server;Server=alpha;Database=main;UID=user;PWD=secret"
        other_server = "Driver=SQL Server;Server=beta;Database=main;UID=user;PWD=secret"
        other_database = "Driver=SQL Server;Server=alpha;Database=archive;UID=user;PWD=secret"
        hashes = {
            self.odbc_fingerprint(base),
            self.odbc_fingerprint(other_server),
            self.odbc_fingerprint(other_database),
        }
        self.assertEqual(len(hashes), 3)

    def test_tally_origin_normalizes_but_company_case_remains_exact(self):
        with patch.dict(
            os.environ,
            {"TALLY_URL": "HTTP://LOCALHOST:080/", "TALLY_COMPANY": "  Acme Jewels  "},
        ):
            first = source_instance_fingerprint(self.TALLY_PROFILE)
        with patch.dict(
            os.environ,
            {"TALLY_URL": "http://localhost", "TALLY_COMPANY": "Acme Jewels"},
        ):
            equivalent = source_instance_fingerprint(self.TALLY_PROFILE)
        with patch.dict(
            os.environ,
            {"TALLY_URL": "http://localhost", "TALLY_COMPANY": "ACME JEWELS"},
        ):
            changed_case = source_instance_fingerprint(self.TALLY_PROFILE)

        self.assertEqual(first, equivalent)
        self.assertNotEqual(first, changed_case)

    @unittest.skipUnless(os.name == "nt", "Access source paths are Windows-only")
    def test_access_path_case_is_normalized_on_windows(self):
        profile = {
            "transport": {"kind": "access_file", "pathEnv": "CONNECT_SOURCE_FILE"}
        }
        with tempfile.TemporaryDirectory() as directory:
            first_path = str(Path(directory) / "ClientData" / "Company.BDS")
            second_path = first_path.swapcase()
            with patch.dict(os.environ, {"CONNECT_SOURCE_FILE": first_path}):
                first = source_instance_fingerprint(profile)
            with patch.dict(os.environ, {"CONNECT_SOURCE_FILE": second_path}):
                second = source_instance_fingerprint(profile)
            with patch.dict(
                os.environ,
                {"CONNECT_SOURCE_FILE": str(Path(directory) / "ClientData" / "Other.BDS")},
            ):
                other = source_instance_fingerprint(profile)

        self.assertEqual(first, second)
        self.assertNotEqual(first, other)


if __name__ == "__main__":
    unittest.main()
