"""Read-only source transports used by connector profiles."""

from __future__ import annotations

import ipaddress
import os
import shutil
import socket
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Mapping
from urllib.parse import urlsplit

import requests

from .profile import ProfileError, normalize_origin_url, safe_select


class SourceError(RuntimeError):
    pass


class SourceLimitExceeded(SourceError):
    """The profile needs reviewed deterministic pagination before it can be safe."""


MAX_TALLY_RESPONSE_BYTES = 16 * 1024 * 1024
ODBC_QUERY_TIMEOUT_SECONDS = 60
ACCESS_COPY_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024
TALLY_HTTP_PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
)


class OdbcSource:
    def __init__(self, profile: Mapping[str, Any]) -> None:
        self.profile = profile
        self.transport = profile["transport"]
        self.connection = None
        self.temporary: Path | None = None

    def __enter__(self) -> "OdbcSource":
        try:
            import pyodbc
        except ImportError as exc:
            raise SourceError("pyodbc is required for ODBC profiles") from exc
        try:
            kind = self.transport["kind"]
            if kind == "access_file":
                path_env = self.transport.get("pathEnv", "CONNECT_SOURCE_FILE")
                password_env = self.transport.get("passwordEnv", "CONNECT_SOURCE_PASSWORD")
                source = Path(os.environ.get(path_env, "")).expanduser()
                if not source.is_file():
                    raise SourceError(f"{path_env} must point to an existing database file")
                before = source.stat()
                free = shutil.disk_usage(tempfile.gettempdir()).free
                required = before.st_size + ACCESS_COPY_FREE_SPACE_MARGIN_BYTES
                if free < required:
                    raise SourceError(
                        "temporary storage does not have enough free space for a safe database copy"
                    )
                handle, name = tempfile.mkstemp(prefix="caratos-connect-", suffix=source.suffix)
                os.close(handle)
                self.temporary = Path(name)
                try:
                    os.chmod(self.temporary, 0o600)
                except OSError:
                    pass
                shutil.copy2(source, self.temporary)
                after = source.stat()
                copied = self.temporary.stat()
                if (
                    before.st_size != after.st_size
                    or before.st_mtime_ns != after.st_mtime_ns
                    or copied.st_size != after.st_size
                ):
                    raise SourceError(
                        "source database changed during the safe copy; retry while BUSY is idle"
                    )
                driver = self.transport.get("driver", "Microsoft Access Driver (*.mdb, *.accdb)")
                password = os.environ.get(password_env, "")
                connection_string = _build_access_connection_string(
                    str(driver), self.temporary, password
                )
            else:
                connection_env = self.transport.get("connectionEnv", "CONNECT_SOURCE_DSN")
                connection_string = os.environ.get(connection_env, "").strip()
                if not connection_string:
                    raise SourceError(f"{connection_env} is required")
            self.connection = pyodbc.connect(connection_string, timeout=15, readonly=True)
        except Exception:
            # __exit__ is not called when __enter__ fails. Clean the client's
            # copied BUSY database here so credentials/errors cannot strand it.
            if self.connection is not None:
                try:
                    self.connection.close()
                except Exception:
                    pass
                self.connection = None
            if self.temporary is not None:
                self.temporary.unlink(missing_ok=True)
                self.temporary = None
            raise
        return self

    def __exit__(self, exc_type: Any, _exc: Any, _traceback: Any) -> None:
        close_error: Exception | None = None
        try:
            if self.connection is not None:
                self.connection.close()
        except Exception as error:
            close_error = error
        finally:
            if self.temporary is not None:
                self.temporary.unlink(missing_ok=True)
        if close_error is not None and exc_type is None:
            raise close_error

    def discover(self) -> Dict[str, Any]:
        cursor = self._cursor()
        tables = []
        for row in cursor.tables(tableType="TABLE"):
            name = str(getattr(row, "table_name", row[2]))
            if name.startswith("MSys"):
                continue
            columns = []
            try:
                for col in cursor.columns(table=name):
                    columns.append(str(getattr(col, "column_name", col[3])))
            except Exception:
                columns = []
            tables.append({"name": name, "columns": columns[:200]})
            if len(tables) >= 200:
                break
        return {"transport": self.transport["kind"], "tables": tables, "sampled": len(tables) >= 200}

    def extract(
        self,
        definition: Mapping[str, Any],
        limit: int,
        detect_overflow: bool = True,
    ) -> list[dict[str, Any]]:
        cursor = self._cursor()
        cursor.execute(safe_select(str(definition["query"])))
        names = [str(column[0]) for column in cursor.description]
        values = cursor.fetchmany(limit + 1)
        if detect_overflow and len(values) > limit:
            raise SourceLimitExceeded(
                f"source returned more than the safe {limit}-row limit; add reviewed deterministic pagination"
            )
        return [dict(zip(names, row)) for row in values[:limit]]

    def _cursor(self):
        if self.connection is None:
            raise SourceError("ODBC source is not open")
        cursor = self.connection.cursor()
        # pyodbc's connect timeout only covers login. A separate cursor timeout
        # prevents a reviewed SELECT from hanging a scheduled task indefinitely.
        cursor.timeout = ODBC_QUERY_TIMEOUT_SECONDS
        return cursor


def _build_access_connection_string(
    driver: str, database: Path, password: str = ""
) -> str:
    """Build an injection-safe, read-only Access ODBC connection string."""
    connection = (
        f"Driver={_odbc_braced_value(driver, 'Access ODBC driver')};"
        f"DBQ={_odbc_braced_value(str(database), 'Access database path')};"
        "Mode=Read;"
    )
    if password:
        connection += f"PWD={_odbc_braced_value(password, 'Access database password')};"
    return connection


def _odbc_braced_value(value: str, label: str) -> str:
    if not value:
        raise SourceError(f"{label} cannot be empty")
    if any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value):
        raise SourceError(f"{label} contains a control character")
    # A braced ODBC value may contain semicolons. A literal closing brace is
    # represented as two braces, preventing it from terminating the value.
    return "{" + value.replace("}", "}}") + "}"


class TallyXmlSource:
    def __init__(self, profile: Mapping[str, Any]) -> None:
        self.profile = profile
        self.transport = profile["transport"]
        url_env = self.transport.get("urlEnv", "TALLY_URL")
        raw_url = os.environ.get(url_env, "http://127.0.0.1:9000")
        self.url = _assert_tally_url(raw_url)
        self.company = os.environ.get(self.transport.get("companyEnv", "TALLY_COMPANY"), "").strip()

    def __enter__(self) -> "TallyXmlSource":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def discover(self) -> Dict[str, Any]:
        self._require_company()
        entities = [
            {"entity": entity, "objectType": definition["objectType"]}
            for entity, definition in self.profile.get("entities", {}).items()
        ]
        # A bounded profile probe proves Tally is listening and exposes which
        # configured record shape was seen, without logging customer values.
        probes = []
        for entity, definition in self.profile.get("entities", {}).items():
            request = build_tally_request(definition, self.company)
            payload = self._post(request)
            rows = parse_tally_records(payload, definition["recordTags"], 1, detect_overflow=False)
            probes.append({"entity": entity, "recordsSeen": min(len(rows), 1), "fields": sorted(rows[0]) if rows else []})
        return {"transport": "tally_xml", "url": self.url, "entities": entities, "probes": probes}

    def extract(
        self,
        definition: Mapping[str, Any],
        limit: int,
        detect_overflow: bool = True,
    ) -> list[dict[str, Any]]:
        self._require_company()
        request = build_tally_request(definition, self.company)
        payload = self._post(request)
        return parse_tally_records(
            payload,
            definition["recordTags"],
            limit,
            detect_overflow=detect_overflow,
        )

    def _post(self, request: bytes) -> bytes:
        with requests.post(
            self.url,
            data=request,
            headers={"Content-Type": "text/xml; charset=utf-8"},
            timeout=60,
            stream=True,
            allow_redirects=False,
        ) as response:
            if 300 <= response.status_code < 400:
                raise SourceError("Tally endpoint redirects are not allowed")
            response.raise_for_status()
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > MAX_TALLY_RESPONSE_BYTES:
                raise SourceError("Tally response exceeds the safe 16 MiB limit")
            content = bytearray()
            for chunk in response.iter_content(chunk_size=64 * 1024):
                content.extend(chunk)
                if len(content) > MAX_TALLY_RESPONSE_BYTES:
                    raise SourceError("Tally response exceeds the safe 16 MiB limit")
        return bytes(content)

    def _require_company(self) -> None:
        if not self.company:
            raise SourceError(
                f"{self.transport.get('companyEnv', 'TALLY_COMPANY')} is required; never use an accidental active company"
            )


def source_for(profile: Mapping[str, Any]):
    kind = profile["transport"]["kind"]
    if kind == "tally_xml":
        return TallyXmlSource(profile)
    return OdbcSource(profile)


def build_tally_request(definition: Mapping[str, Any], company: str) -> bytes:
    object_type = definition["objectType"]
    collection = f"CaratOS {object_type} Export"
    fetch = []
    for candidates in definition["fields"].values():
        for candidate in candidates:
            clean = candidate.replace(".LIST", "")
            if clean not in fetch:
                fetch.append(clean)
    envelope = ET.Element("ENVELOPE")
    header = ET.SubElement(envelope, "HEADER")
    ET.SubElement(header, "VERSION").text = "1"
    ET.SubElement(header, "TALLYREQUEST").text = "Export"
    ET.SubElement(header, "TYPE").text = "COLLECTION"
    ET.SubElement(header, "ID").text = collection
    body = ET.SubElement(envelope, "BODY")
    desc = ET.SubElement(body, "DESC")
    static = ET.SubElement(desc, "STATICVARIABLES")
    ET.SubElement(static, "SVEXPORTFORMAT").text = "$$SysName:XML"
    if company:
        ET.SubElement(static, "SVCURRENTCOMPANY").text = company
    tdl = ET.SubElement(desc, "TDL")
    message = ET.SubElement(tdl, "TDLMESSAGE")
    coll = ET.SubElement(message, "COLLECTION", {"NAME": collection})
    ET.SubElement(coll, "TYPE").text = object_type
    ET.SubElement(coll, "FETCH").text = ",".join(fetch)
    return ET.tostring(envelope, encoding="utf-8", xml_declaration=True)


def parse_tally_records(
    payload: bytes,
    record_tags: list[str],
    limit: int,
    detect_overflow: bool = True,
) -> list[dict[str, str]]:
    if len(payload) > MAX_TALLY_RESPONSE_BYTES:
        raise SourceError("Tally response exceeds the safe 16 MiB limit")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise SourceError(f"Tally returned invalid XML: {exc}") from exc
    for element in root.iter():
        tag = _tag(element.tag).upper()
        value = (element.text or "").strip()
        if tag == "LINEERROR" and value:
            raise SourceError(f"Tally rejected the request: {value[:500]}")
        if tag == "STATUS" and value.upper() in {"0", "FAILURE", "FAILED", "ERROR"}:
            raise SourceError("Tally reported a failed export status")

    tags = {tag.upper() for tag in record_tags}
    rows = []
    for element in root.iter():
        if _tag(element.tag).upper() not in tags:
            continue
        row: dict[str, str] = {
            _tag(key).upper(): str(value).strip()
            for key, value in element.attrib.items()
            if str(value).strip()
        }
        for child in element.iter():
            for key, value in child.attrib.items():
                if str(value).strip():
                    row.setdefault(_tag(key).upper(), str(value).strip())
            if child is element or not (child.text or "").strip():
                continue
            key = _tag(child.tag).upper()
            row.setdefault(key, (child.text or "").strip())
        if not row:
            continue
        if len(rows) >= limit:
            if detect_overflow:
                raise SourceLimitExceeded(
                    f"Tally returned more than the safe {limit}-row limit; add reviewed deterministic pagination"
                )
            break
        rows.append(row)
    return rows


def _tag(value: str) -> str:
    return value.rsplit("}", 1)[-1]


def _assert_tally_url(url: str) -> str:
    try:
        normalized = normalize_origin_url(url, "TALLY_URL")
    except ProfileError as exc:
        raise SourceError(str(exc)) from exc
    parsed = urlsplit(normalized)
    if parsed.scheme == "https":
        return normalized
    host = parsed.hostname or ""
    if host == "localhost":
        return normalized
    try:
        try:
            addresses = [ipaddress.ip_address(host)]
        except ValueError:
            addresses = [
                ipaddress.ip_address(result[4][0])
                for result in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
            ]
    except (ValueError, OSError) as exc:
        raise SourceError("TALLY_URL host could not be resolved") from exc
    if not addresses or any(not _is_tally_http_address_allowed(item) for item in addresses):
        raise SourceError("plain HTTP TALLY_URL is allowed only on localhost/private LAN")
    return normalized


def _is_tally_http_address_allowed(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    mapped = getattr(address, "ipv4_mapped", None)
    candidate = mapped or address
    return candidate.is_loopback or any(candidate in network for network in TALLY_HTTP_PRIVATE_NETWORKS)
