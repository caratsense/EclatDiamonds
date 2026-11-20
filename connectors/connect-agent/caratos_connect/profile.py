"""Load and fail-closed validate non-secret connector profiles."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Mapping
from urllib.parse import urlsplit

SUPPORTED_SOURCES = {"busy", "tally", "gati", "odbc"}
SUPPORTED_ENTITIES = {"customers", "products", "stores"}
SUPPORTED_TRANSPORTS = {"odbc", "access_file", "tally_xml"}
ROOT_KEYS = {
    "schemaVersion", "id", "displayName", "notes", "sourceSystem",
    "discoveryOnly", "transport", "entities",
}
TRANSPORT_KEYS = {
    "kind", "connectionEnv", "pathEnv", "passwordEnv", "urlEnv",
    "companyEnv", "driver",
}
ENTITY_KEYS = {
    "query", "objectType", "recordTags", "fields", "prefixValues",
    "required", "include", "allowEmpty",
}
FILTER_KEYS = {"field", "containsAny", "equalsAny"}
ODBC_CREDENTIAL_KEYS = {
    "accountkey", "accesstoken", "apikey", "clientkey", "clientsecret",
    "credential", "credentials", "pass", "password", "pwd", "secret",
    "token", "uid", "user", "userid", "username",
}
ODBC_CREDENTIAL_MARKERS = {
    "accesskey", "apikey", "clientkey", "clientsecret", "credential",
    "passwd", "password", "privatekey", "pwd", "secret", "sslkey",
    "token",
}
ODBC_SOURCE_KEY_ALIASES = {
    "account": "account",
    "addr": "server",
    "address": "server",
    "attachdbfilename": "database-file",
    "catalog": "database",
    "cluster": "cluster",
    "database": "database",
    "datasource": "server",
    "db": "database",
    "dbname": "database",
    "dbq": "database-file",
    "driver": "driver",
    "dsn": "dsn",
    "filedsn": "file-dsn",
    "host": "server",
    "hostname": "server",
    "initialcatalog": "database",
    "instance": "instance",
    "instancename": "instance",
    "networkaddress": "server",
    "port": "port",
    "project": "project",
    "server": "server",
    "servername": "server",
    "service": "service",
    "servicename": "service",
    "warehouse": "warehouse",
}
REQUIRED_FIELDS = {
    # Every machine record needs a stable source id. Phone/name are business
    # attributes, not safe identities (families and companies share them).
    "customers": {"code", "name"},
    "products": {"sku", "name"},
    "stores": {"code", "name"},
}
CANONICAL_FIELDS = {
    "customers": {"code", "name", "phone", "email", "city", "gstin", "birthday", "anniversary"},
    "products": {"sku", "name", "category", "metal", "karat", "weightGrams", "price", "unitOfMeasure"},
    "stores": {"code", "name", "city", "gstin", "phone", "email", "addressLine1", "state", "pincode"},
}
TRANSPORTS_BY_SOURCE = {
    "busy": {"access_file", "odbc"},
    "tally": {"tally_xml"},
    "gati": {"odbc"},
    "odbc": {"odbc"},
}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")
ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,79}$")
SQL_WRITE_RE = re.compile(
    r"\b(insert|update|delete|drop|alter|create|merge|replace|truncate|grant|revoke|execute|exec)\b|\bselect\s+.+\s+into\b",
    re.IGNORECASE | re.DOTALL,
)


class ProfileError(ValueError):
    pass


def normalize_origin_url(value: str, label: str) -> str:
    """Validate and canonicalize an HTTP(S) origin without echoing its value."""
    if not isinstance(value, str) or not value.strip():
        raise ProfileError(f"{label} must be an HTTP(S) URL")
    raw = value.strip()
    # urlsplit does not distinguish an absent query/fragment from a present,
    # empty one. Origins disallow both delimiters, including a trailing ?/#.
    if "?" in raw or "#" in raw:
        raise ProfileError(f"{label} must be an origin without a query or fragment")
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        username = parsed.username
        password = parsed.password
        port = parsed.port
    except ValueError as exc:
        raise ProfileError(f"{label} has an invalid host or port") from exc

    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"} or not parsed.netloc or not host:
        raise ProfileError(f"{label} must be an HTTP(S) URL with a host")
    if username is not None or password is not None:
        raise ProfileError(f"{label} must not contain user information")
    if parsed.path not in {"", "/"}:
        raise ProfileError(f"{label} must be an origin without a path")
    if parsed.netloc.endswith(":") or (port is not None and not 1 <= port <= 65535):
        raise ProfileError(f"{label} has an invalid port")

    normalized_host = host.casefold()
    if any(character.isspace() or character in "\\/" for character in normalized_host):
        raise ProfileError(f"{label} has an invalid host")
    try:
        normalized_host = ipaddress.ip_address(normalized_host).compressed
    except ValueError:
        try:
            normalized_host = normalized_host.encode("idna").decode("ascii").rstrip(".")
        except UnicodeError as exc:
            raise ProfileError(f"{label} has an invalid host") from exc
        labels = normalized_host.split(".")
        if (
            len(normalized_host) > 253
            or not re.fullmatch(r"[a-z0-9._-]+", normalized_host)
            or any(
                not item or len(item) > 63 or item.startswith("-") or item.endswith("-")
                for item in labels
            )
        ):
            raise ProfileError(f"{label} has an invalid host")

    authority_host = f"[{normalized_host}]" if ":" in normalized_host else normalized_host
    default_port = 80 if scheme == "http" else 443
    authority = authority_host if port in {None, default_port} else f"{authority_host}:{port}"
    return f"{scheme}://{authority}"


def safe_select(query: str) -> str:
    """Accept one read-only SELECT/CTE and reject comments or write vocabulary."""
    value = query.strip().rstrip(";").strip()
    if not value or not re.match(r"^(select|with)\b", value, re.IGNORECASE):
        raise ProfileError("ODBC entity query must start with SELECT or WITH")
    if ";" in value or "--" in value or "/*" in value or "*/" in value:
        raise ProfileError("ODBC entity query must be one statement without SQL comments")
    if SQL_WRITE_RE.search(value):
        raise ProfileError("ODBC entity query must be read-only")
    return value


def _candidate_list(value: Any, label: str) -> list[str]:
    values = [value] if isinstance(value, str) else value
    if not isinstance(values, list) or not values:
        raise ProfileError(f"{label} must be a string or non-empty string list")
    if any(not isinstance(item, str) for item in values):
        raise ProfileError(f"{label} must contain only strings")
    cleaned = [item.strip() for item in values if item.strip()]
    if not cleaned or len(cleaned) != len(values):
        raise ProfileError(f"{label} contains an empty candidate")
    return cleaned


def validate_profile(raw: Mapping[str, Any]) -> Dict[str, Any]:
    profile = dict(raw)
    _reject_unknown(profile, ROOT_KEYS, "profile")
    schema_version = profile.get("schemaVersion")
    if isinstance(schema_version, bool) or not isinstance(schema_version, int) or schema_version != 1:
        raise ProfileError("schemaVersion must be 1")
    profile_id = profile.get("id")
    if not isinstance(profile_id, str) or not ID_RE.fullmatch(profile_id):
        raise ProfileError("profile id must be 2-80 lowercase letters, digits, dot, dash or underscore")
    for key, maximum in (("displayName", 120), ("notes", 2000)):
        if key in profile and (
            not isinstance(profile[key], str) or len(profile[key]) > maximum
        ):
            raise ProfileError(f"{key} must be a string of at most {maximum} characters")
    discovery_only = profile.get("discoveryOnly", False)
    if not isinstance(discovery_only, bool):
        raise ProfileError("discoveryOnly must be a boolean")
    source = profile.get("sourceSystem")
    if source not in SUPPORTED_SOURCES:
        raise ProfileError(f"sourceSystem must be one of: {', '.join(sorted(SUPPORTED_SOURCES))}")
    transport = profile.get("transport")
    if not isinstance(transport, dict) or transport.get("kind") not in SUPPORTED_TRANSPORTS:
        raise ProfileError(f"transport.kind must be one of: {', '.join(sorted(SUPPORTED_TRANSPORTS))}")
    _reject_unknown(transport, TRANSPORT_KEYS, "transport")
    for key in ("connectionEnv", "pathEnv", "passwordEnv", "urlEnv", "companyEnv"):
        if key in transport and (
            not isinstance(transport[key], str) or not ENV_RE.fullmatch(transport[key])
        ):
            raise ProfileError(f"transport.{key} must be an uppercase environment variable name")
    if "driver" in transport and (
        not isinstance(transport["driver"], str) or not 1 <= len(transport["driver"].strip()) <= 200
    ):
        raise ProfileError("transport.driver must be a non-empty string of at most 200 characters")
    if transport["kind"] not in TRANSPORTS_BY_SOURCE[source]:
        raise ProfileError(f"{source} profiles cannot use {transport['kind']} transport")
    allowed_transport_keys = {
        "odbc": {"kind", "connectionEnv"},
        "access_file": {"kind", "pathEnv", "passwordEnv", "driver"},
        "tally_xml": {"kind", "urlEnv", "companyEnv"},
    }[transport["kind"]]
    irrelevant = sorted(set(transport) - allowed_transport_keys)
    if irrelevant:
        raise ProfileError(
            f"{transport['kind']} transport has unsupported keys: {', '.join(irrelevant)}"
        )

    entities = profile.get("entities", {})
    if not isinstance(entities, dict):
        raise ProfileError("entities must be an object")
    if not entities and not discovery_only:
        raise ProfileError("profile needs an entity or discoveryOnly=true")
    for entity, definition in entities.items():
        if entity not in SUPPORTED_ENTITIES:
            raise ProfileError(f"unsupported entity {entity!r}")
        if not isinstance(definition, dict):
            raise ProfileError(f"entities.{entity} must be an object")
        _reject_unknown(definition, ENTITY_KEYS, f"entities.{entity}")
        if "allowEmpty" in definition and not isinstance(definition["allowEmpty"], bool):
            raise ProfileError(f"entities.{entity}.allowEmpty must be a boolean")
        fields = definition.get("fields")
        if not isinstance(fields, dict):
            raise ProfileError(f"entities.{entity}.fields must be an object")
        if any(not isinstance(key, str) or not key for key in fields):
            raise ProfileError(f"entities.{entity}.fields keys must be non-empty strings")
        normalized_fields = {
            key: _candidate_list(value, f"entities.{entity}.fields.{key}")
            for key, value in fields.items()
        }
        unknown = sorted(
            field for field in normalized_fields
            if not field.startswith("_") and field not in CANONICAL_FIELDS[entity]
        )
        if unknown:
            raise ProfileError(
                f"entities.{entity} has unknown canonical fields: {', '.join(unknown)}"
            )
        missing = REQUIRED_FIELDS[entity] - set(normalized_fields)
        if missing:
            raise ProfileError(f"entities.{entity} is missing required mappings: {', '.join(sorted(missing))}")
        definition["fields"] = normalized_fields
        prefixes = definition.get("prefixValues", {})
        if not isinstance(prefixes, dict) or any(key not in normalized_fields for key in prefixes):
            raise ProfileError(f"entities.{entity}.prefixValues references an unknown field")
        if any(
            not isinstance(value, str) or not value or len(value) > 40
            for value in prefixes.values()
        ):
            raise ProfileError(f"entities.{entity}.prefixValues must contain non-empty short strings")
        identity_field = "code" if entity in {"customers", "stores"} else "sku"
        expected_prefix = f"{source}:"
        if prefixes.get(identity_field) != expected_prefix:
            raise ProfileError(
                f"entities.{entity}.prefixValues.{identity_field} must be {expected_prefix!r}"
            )
        required = definition.get("required", [])
        if not isinstance(required, list) or any(
            not isinstance(item, str) or item not in normalized_fields for item in required
        ):
            raise ProfileError(f"entities.{entity}.required must reference mapped fields")
        if len(required) != len(set(required)):
            raise ProfileError(f"entities.{entity}.required cannot contain duplicates")
        include = definition.get("include", [])
        if not isinstance(include, list):
            raise ProfileError(f"entities.{entity}.include must be an array")
        for index, rule in enumerate(include):
            if not isinstance(rule, dict) or rule.get("field") not in normalized_fields:
                raise ProfileError(f"entities.{entity}.include[{index}] references an unknown field")
            _reject_unknown(rule, FILTER_KEYS, f"entities.{entity}.include[{index}]")
            operators = [name for name in ("containsAny", "equalsAny") if name in rule]
            if len(operators) != 1:
                raise ProfileError(
                    f"entities.{entity}.include[{index}] needs exactly one filter operator"
                )
            rule[operators[0]] = _candidate_list(
                rule[operators[0]], f"entities.{entity}.include[{index}].{operators[0]}"
            )
        if transport["kind"] in {"odbc", "access_file"}:
            unexpected = {"objectType", "recordTags"}.intersection(definition)
            if unexpected:
                raise ProfileError(
                    f"entities.{entity} has Tally-only keys for an ODBC transport: {', '.join(sorted(unexpected))}"
                )
            query = definition.get("query")
            if not isinstance(query, str):
                raise ProfileError(f"entities.{entity}.query must be a string")
            definition["query"] = safe_select(query)
        else:
            if "query" in definition:
                raise ProfileError(f"entities.{entity}.query is not valid for Tally XML")
            object_type = definition.get("objectType")
            if not isinstance(object_type, str) or not re.fullmatch(
                r"[A-Za-z][A-Za-z0-9 ]{0,60}", object_type
            ):
                raise ProfileError(f"entities.{entity}.objectType is invalid")
            definition["recordTags"] = _candidate_list(
                definition.get("recordTags", []), f"entities.{entity}.recordTags"
            )
    return profile


def _reject_unknown(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(str(key) for key in value if key not in allowed)
    if unknown:
        raise ProfileError(f"{label} has unsupported keys: {', '.join(unknown)}")


def profile_fingerprint(profile: Mapping[str, Any]) -> str:
    """Hash the reviewed, non-secret profile content (never its local path)."""
    value = {key: item for key, item in profile.items() if not key.startswith("_")}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def source_instance_fingerprint(profile: Mapping[str, Any]) -> str:
    """Hash a canonical, credential-free source identity descriptor."""
    transport = profile["transport"]
    kind = transport["kind"]
    if kind == "tally_xml":
        company_env = transport.get("companyEnv", "TALLY_COMPANY")
        company = os.environ.get(company_env, "").strip()
        if not company:
            raise ProfileError(f"{company_env} is required; never sync whichever Tally company happens to be open")
        url_env = transport.get("urlEnv", "TALLY_URL")
        url = os.environ.get(url_env, "http://127.0.0.1:9000")
        material: list[Any] = ["tally", normalize_origin_url(url, url_env), company]
    elif kind == "access_file":
        path_env = transport.get("pathEnv", "CONNECT_SOURCE_FILE")
        source = os.environ.get(path_env, "").strip()
        if not source:
            raise ProfileError(f"{path_env} is required")
        resolved = str(Path(source).expanduser().resolve())
        # Access installations are Windows-only. Windows paths are
        # case-insensitive, so spelling/case cannot create a second identity.
        if os.name == "nt":
            resolved = os.path.normcase(resolved)
        material = ["access", resolved]
    else:
        connection_env = transport.get("connectionEnv", "CONNECT_SOURCE_DSN")
        connection = os.environ.get(connection_env, "").strip()
        if not connection:
            raise ProfileError(f"{connection_env} is required")
        material = ["odbc", _odbc_source_descriptor(connection)]
    encoded = json.dumps(material, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _odbc_source_descriptor(connection: str) -> list[list[str]]:
    """Canonical credential-free ODBC selectors for stable identity."""
    attributes: dict[str, str] = {}
    for part in _split_odbc_connection(connection):
        if not part.strip():
            continue
        if "=" not in part:
            raise ProfileError("ODBC connection string must contain key=value attributes")
        raw_key, raw_value = part.split("=", 1)
        key = " ".join(raw_key.split()).casefold()
        if not key:
            raise ProfileError("ODBC connection string contains an empty key")
        credential_key = re.sub(r"[\s_-]+", "", key)
        if not credential_key:
            raise ProfileError("ODBC connection string contains an invalid key")
        if credential_key in ODBC_CREDENTIAL_KEYS or any(
            marker in credential_key for marker in ODBC_CREDENTIAL_MARKERS
        ):
            continue
        # Driver-specific selectors (for example CurrentSchema, Role,
        # Encrypt or ApplicationIntent) can change what rows are visible.
        # Ignoring them would let a materially different source reuse an old
        # approval. Preserve every non-secret option under a collision-safe
        # namespace while still normalizing well-known locator aliases.
        source_key = ODBC_SOURCE_KEY_ALIASES.get(
            credential_key, f"option:{credential_key}"
        )
        if source_key in attributes:
            raise ProfileError(
                f"ODBC connection string has duplicate {source_key!r} source attributes"
            )
        attributes[source_key] = _normalize_odbc_value(raw_value)
    if not attributes or set(attributes) == {"driver"}:
        raise ProfileError(
            "ODBC connection string needs a server, database, file, DSN or other source locator"
        )
    return [[key, attributes[key]] for key in sorted(attributes)]


def _split_odbc_connection(connection: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    in_braces = False
    index = 0
    while index < len(connection):
        character = connection[index]
        if character == "{" and not in_braces:
            in_braces = True
            current.append(character)
        elif character == "}" and in_braces:
            if index + 1 < len(connection) and connection[index + 1] == "}":
                current.extend(("}", "}"))
                index += 1
            else:
                in_braces = False
                current.append(character)
        elif character == ";" and not in_braces:
            parts.append("".join(current))
            current = []
        else:
            current.append(character)
        index += 1
    if in_braces:
        raise ProfileError("ODBC connection string contains an unterminated braced value")
    parts.append("".join(current))
    return parts


def _normalize_odbc_value(value: str) -> str:
    normalized = value.strip()
    if normalized.startswith("{"):
        if not normalized.endswith("}"):
            raise ProfileError("ODBC connection string contains a malformed braced value")
        normalized = normalized[1:-1].replace("}}", "}").strip()
    return normalized


def load_profile(path: str | Path) -> Dict[str, Any]:
    source = Path(path).expanduser().resolve()
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ProfileError(f"profile not found: {source}") from exc
    except json.JSONDecodeError as exc:
        raise ProfileError(f"profile is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ProfileError("profile root must be an object")
    profile = validate_profile(raw)
    profile["_path"] = str(source)
    return profile
