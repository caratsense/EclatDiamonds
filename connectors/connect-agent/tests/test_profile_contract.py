import copy
import unittest

from caratos_connect.profile import ProfileError, validate_profile


class ProfilePrimitiveContractTests(unittest.TestCase):
    BASE = {
        "schemaVersion": 1,
        "id": "strict-primitive-profile",
        "displayName": "Strict profile",
        "sourceSystem": "odbc",
        "transport": {"kind": "odbc", "connectionEnv": "CONNECT_SOURCE_DSN"},
        "entities": {
            "customers": {
                "query": "SELECT id, name FROM customers",
                "fields": {"code": "id", "name": "name"},
                "prefixValues": {"code": "odbc:"},
            }
        },
    }

    def test_schema_version_and_profile_id_reject_python_coercions(self):
        for field, value, message in (
            ("schemaVersion", True, "schemaVersion"),
            ("id", 12, "profile id"),
        ):
            profile = copy.deepcopy(self.BASE)
            profile[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ProfileError, message):
                validate_profile(profile)

    def test_discovery_only_and_documentation_fields_have_exact_types_and_limits(self):
        for field, value, message in (
            ("discoveryOnly", "false", "boolean"),
            ("displayName", 123, "displayName"),
            ("displayName", "x" * 121, "displayName"),
            ("notes", "x" * 2001, "notes"),
        ):
            profile = copy.deepcopy(self.BASE)
            profile[field] = value
            with self.subTest(field=field, value_type=type(value)), self.assertRaisesRegex(
                ProfileError, message
            ):
                validate_profile(profile)

    def test_transport_specific_keys_cannot_be_smuggled_into_another_transport(self):
        for key, value in (
            ("pathEnv", "CONNECT_SOURCE_FILE"),
            ("passwordEnv", "CONNECT_SOURCE_PASSWORD"),
            ("urlEnv", "TALLY_URL"),
            ("companyEnv", "TALLY_COMPANY"),
            ("driver", "Some driver"),
        ):
            profile = copy.deepcopy(self.BASE)
            profile["transport"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ProfileError, "unsupported keys"):
                validate_profile(profile)

    def test_query_and_tally_object_type_must_be_strings(self):
        profile = copy.deepcopy(self.BASE)
        profile["entities"]["customers"]["query"] = 123
        with self.assertRaisesRegex(ProfileError, "query must be a string"):
            validate_profile(profile)

        tally = copy.deepcopy(self.BASE)
        tally.update(
            {
                "sourceSystem": "tally",
                "transport": {"kind": "tally_xml"},
                "entities": {
                    "customers": {
                        "objectType": 123,
                        "recordTags": ["LEDGER"],
                        "fields": {"code": "GUID", "name": "NAME"},
                        "prefixValues": {"code": "tally:"},
                    }
                },
            }
        )
        with self.assertRaisesRegex(ProfileError, "objectType is invalid"):
            validate_profile(tally)


if __name__ == "__main__":
    unittest.main()
