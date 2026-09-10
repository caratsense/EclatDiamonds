"""Restricted Connect-agent authentication for the legacy Gati adapter.

The legacy data mapper remains client-specific, but it no longer authenticates
as a human head-office user. Head office approves the mapping contract and the
credential-free SQL source descriptor; the API returns its server-controlled
configuration generation, and every legacy ingestion request presents all three.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping
from urllib.parse import urlsplit, urlunsplit

import requests


PROFILE_ID = "gati-sjep-legacy-v1"
AGENT_VERSION = "0.3.0"
PROTOCOL_VERSION = 1
HEARTBEAT_INTERVAL_SECONDS = 240
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_REVISION = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_SEMVER = re.compile(
    r"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$"
)
_MAPPING_FILES = ("sync_sjep.py", "sync_media.py", "import_website.py")
_PROFILE_CONTRACT = {
    "id": PROFILE_ID,
    "schemaVersion": 1,
    "sourceSystem": "gati",
    "transport": "sql_server_odbc",
    "mappingGeneration": 1,
    "routes": [
        "bags",
        "ledger",
        "order-items",
        "orders",
        "parties",
        "product-images",
        "products",
        "raw",
        "sale-lines",
        "sales",
        "staff",
        "stock",
        "stock-movements",
        "stores",
        "website-products",
    ],
}


class GatiAuthError(RuntimeError):
    pass


class HeartbeatReporter:
    """Report legacy-agent liveness without leaking client configuration.

    ``periodic`` is deliberately throttled: callers may invoke it after every
    extracted or uploaded chunk without creating a heartbeat storm. Terminal
    methods always send, and every response is re-checked against the approved
    profile, source and Connect protocol before its config revision is trusted.
    """

    def __init__(
        self,
        origin: str,
        token: str,
        local: Mapping[str, str],
        headers: dict[str, str],
        *,
        session: requests.Session | None = None,
        interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("heartbeat interval must be positive")
        self._origin = origin
        self._token = token
        self._local = dict(local)
        self._headers = headers
        self._session = session
        self._interval = interval_seconds
        self._clock = clock
        self._last_sent: float | None = None
        self._approved_revision: str | None = None
        # A generation transition is fatal for the whole process lifetime.  Do
        # not let a later heartbeat that happens to return the old revision
        # "heal" the reporter and resume uploads in a mixed-generation cycle.
        self._invalid_error: str | None = None

    def periodic(self, stats: Mapping[str, object] | None = None) -> bool:
        """Send an active beat only when the throttle window has elapsed."""
        self._ensure_valid()
        now = self._clock()
        if self._last_sent is not None and now - self._last_sent < self._interval:
            return False
        self._send("active", stats=stats, sent_at=now)
        return True

    def success(self, stats: Mapping[str, object] | None = None) -> None:
        """Send an unthrottled healthy terminal beat and advance lastSyncAt."""
        self._send("active", stats=stats, synced=True, sent_at=self._clock())

    def error(
        self,
        error: BaseException | str,
        stats: Mapping[str, object] | None = None,
    ) -> None:
        """Send an unthrottled terminal error with a redacted bounded message."""
        self._send(
            "error",
            stats=stats,
            error=_safe_error(error, self._token),
            sent_at=self._clock(),
        )

    def _send(
        self,
        status: str,
        *,
        stats: Mapping[str, object] | None = None,
        error: str | None = None,
        synced: bool = False,
        sent_at: float,
        http=None,
    ) -> dict:
        self._ensure_valid()
        payload: dict[str, object] = {
            "status": status,
            "agentVersion": AGENT_VERSION,
        }
        safe_stats = _safe_stats(stats)
        if safe_stats:
            payload["stats"] = safe_stats
        if error is not None:
            payload["error"] = error
        if synced:
            payload["syncedAt"] = (
                datetime.now(timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )

        client = http or self._session or requests.Session()
        close = http is None and self._session is None
        try:
            policy = _request_json(
                client,
                "post",
                f"{self._origin}/integration/connect/heartbeat",
                headers={"Authorization": f"Bearer {self._token}"},
                json=payload,
                timeout=30,
                allow_redirects=False,
            )
            revision = _validate_policy(
                policy, self._local, check_source_pin=False
            )
            if (
                self._approved_revision is not None
                and revision != self._approved_revision
            ):
                self._invalid_error = (
                    "head office changed the connector configuration during this "
                    "run; restart the cycle before sending another batch"
                )
                raise GatiAuthError(self._invalid_error)
            # Keep data uploads on the exact server generation most recently
            # acknowledged by a heartbeat.
            self._approved_revision = revision
            self._headers["x-caratos-config-revision"] = revision
            self._last_sent = sent_at
            return policy
        finally:
            if close:
                client.close()

    def _ensure_valid(self) -> None:
        if self._invalid_error is not None:
            raise GatiAuthError(self._invalid_error)


def profile_hash() -> str:
    # Bind approval to the actual adapter code, not only a hand-maintained
    # generation number. Even a forgotten generation bump changes this hash and
    # therefore fails closed until head office reviews and approves it.
    return _fingerprint(
        {**_PROFILE_CONTRACT, "mapperCodeSha256": _mapping_code_hashes()}
    )


def source_instance_hash(server: str, database: str) -> str:
    server_name = _required_label(server, "SQL Server").casefold()
    database_name = _required_label(database, "database").casefold()
    return _fingerprint(
        {
            "kind": "gati_sql_server_odbc",
            "driver": "odbc driver 17 for sql server",
            "server": server_name,
            "database": database_name,
        }
    )


def approval_summary(server: str, database: str) -> dict[str, str]:
    return {
        "profileId": PROFILE_ID,
        "profileHash": profile_hash(),
        "sourceInstanceHash": source_instance_hash(server, database),
    }


def approved_headers(
    base_url: str,
    token: str,
    server: str,
    database: str,
    session: requests.Session | None = None,
) -> dict[str, str]:
    headers, _ = approved_connection(
        base_url, token, server, database, session=session
    )
    return headers


def approved_connection(
    base_url: str,
    token: str,
    server: str,
    database: str,
    session: requests.Session | None = None,
    *,
    interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, str], HeartbeatReporter]:
    """Approve the exact adapter/source and return upload headers + reporter."""
    origin = _origin(base_url)
    secret = token.strip()
    if not secret.startswith("cxa_"):
        raise GatiAuthError("a CaratOS Connect agent token is required")
    local = approval_summary(server, database)
    http = session or requests.Session()
    close = session is None
    try:
        identity = _request_json(
            http,
            "get",
            f"{origin}/integration/connect/me",
            headers={"Authorization": f"Bearer {secret}"},
            timeout=30,
            allow_redirects=False,
        )
        _validate_policy(identity, local, check_source_pin=True)

        headers = {
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
            "x-caratos-profile-id": PROFILE_ID,
            "x-caratos-profile-hash": local["profileHash"],
            "x-caratos-source-instance-hash": local["sourceInstanceHash"],
            # Filled only after the awaited active heartbeat below validates the
            # server's current policy generation.
            "x-caratos-config-revision": "pending",
        }
        reporter = HeartbeatReporter(
            origin,
            secret,
            local,
            headers,
            session=session,
            interval_seconds=interval_seconds,
            clock=clock,
        )

        # Authentication itself never mutates liveness. Check in explicitly and
        # await the response so an error heartbeat cannot race a guard-side
        # best-effort "active" update. Re-validate the returned policy in case
        # head office replaced configuration between GET /me and this beat.
        reporter._send("active", sent_at=clock(), http=http)
        return headers, reporter
    finally:
        if close:
            http.close()


def _request_json(http, method: str, url: str, **kwargs):
    response = getattr(http, method)(url, **kwargs)
    if 300 <= response.status_code < 400:
        raise GatiAuthError("Connect handshake redirects are not allowed")
    if not 200 <= response.status_code < 300:
        raise GatiAuthError(f"Connect handshake failed with HTTP {response.status_code}")
    try:
        value = response.json()
    except Exception as exc:
        raise GatiAuthError("Connect handshake returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise GatiAuthError("Connect handshake returned invalid JSON")
    return value


def _validate_policy(identity: dict, local: dict[str, str], check_source_pin: bool) -> str:
    _validate_protocol(identity)
    if identity.get("sourceSystem") != "gati":
        raise GatiAuthError("the token is not enrolled for the Gati connector")
    if identity.get("storeId") is not None:
        raise GatiAuthError("legacy Gati sync requires an organisation-wide agent")
    if identity.get("enabled") is not True:
        raise GatiAuthError("the Gati Connect agent is disabled")
    if identity.get("expectedProfileHash") != local["profileHash"]:
        raise GatiAuthError("head office has not approved this exact Gati mapping profile")
    if identity.get("expectedSourceInstanceHash") != local["sourceInstanceHash"]:
        raise GatiAuthError("head office has not approved this exact SQL source descriptor")
    if check_source_pin:
        pinned = identity.get("sourceInstanceHash")
        if pinned is not None and pinned != local["sourceInstanceHash"]:
            raise GatiAuthError("the Gati agent is pinned to a different SQL source")
    revision = identity.get("configRevision")
    if not isinstance(revision, str) or not _REVISION.fullmatch(revision):
        raise GatiAuthError("the server returned no valid connector configuration generation")
    return revision


def _validate_protocol(identity: Mapping[str, object]) -> None:
    protocol = identity.get("protocolVersion")
    if type(protocol) is not int or protocol != PROTOCOL_VERSION:
        raise GatiAuthError(
            f"unsupported Connect protocol {protocol!r}; "
            f"legacy adapter requires {PROTOCOL_VERSION}"
        )
    minimum = identity.get("minimumAgentVersion")
    maximum = identity.get("maximumAgentVersion")
    if not isinstance(minimum, str) or not isinstance(maximum, str):
        raise GatiAuthError("the server returned an invalid agent-version range")
    current_version = _semver(AGENT_VERSION)
    minimum_version = _semver(minimum)
    maximum_version = _semver(maximum)
    if minimum_version > maximum_version:
        raise GatiAuthError("the server returned an invalid agent-version range")
    if not minimum_version <= current_version <= maximum_version:
        raise GatiAuthError(
            f"legacy adapter {AGENT_VERSION} is outside the server-supported "
            f"range {minimum}..{maximum}"
        )


def _semver(value: str) -> tuple[int, int, int]:
    match = _SEMVER.fullmatch(value)
    if not match:
        raise GatiAuthError(f"the server returned an invalid agent version {value!r}")
    return tuple(int(part) for part in match.groups())


def _fingerprint(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("ascii")).hexdigest()


def _mapping_code_hashes() -> dict[str, str]:
    root = Path(__file__).resolve().parent
    output: dict[str, str] = {}
    for name in _MAPPING_FILES:
        try:
            # Universal-newline text makes an otherwise identical Windows ZIP
            # and Git checkout produce the same reviewed contract.
            source = (root / name).read_text(encoding="utf-8").replace("\r\n", "\n")
        except (OSError, UnicodeError) as exc:
            raise GatiAuthError(f"required Gati mapping file is unavailable: {name}") from exc
        output[name] = hashlib.sha256(source.encode("utf-8")).hexdigest()
    # This client-specific status/department map changes order-stage semantics
    # just as surely as Python code does. Missing is an explicit reviewed state;
    # adding or changing the file therefore forces a new approval.
    output["stage_map.json"] = _optional_json_hash(root / "stage_map.json")
    return output


def _optional_json_hash(path: Path) -> str:
    if not path.is_file():
        return "missing"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GatiAuthError(f"Gati mapping file is invalid: {path.name}") from exc
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


def _required_label(value: str, label: str) -> str:
    cleaned = " ".join(str(value).strip().split())
    if not cleaned or len(cleaned) > 255:
        raise GatiAuthError(f"{label} is missing or invalid")
    return cleaned


def _safe_error(error: BaseException | str, token: str) -> str:
    """Return a one-line diagnostic safe enough for the tenant dashboard."""
    if isinstance(error, BaseException):
        raw = f"{type(error).__name__}: {error}"
    else:
        raw = str(error)
    value = " ".join(raw.replace("\x00", " ").split())
    if token:
        value = value.replace(token, "[REDACTED]")
    # Cover common DSN/log formats without trying to preserve the secret's
    # shape. This is defense in depth; the API performs its own redaction too.
    value = re.sub(
        r"(?i)\b(password|pwd|token|secret|api[_-]?key|access[_-]?key)\b"
        r"\s*[:=]\s*(?:\{[^}]*\}|[^;,&\s]+)",
        lambda match: f"{match.group(1)}=[REDACTED]",
        value,
    )
    value = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [REDACTED]", value)
    value = re.sub(
        r"(?i)(https?://)([^/@\s]+)@",
        r"\1[REDACTED]@",
        value,
    )
    return (value or "The legacy Gati adapter reported an error.")[:500]


def _safe_stats(stats: Mapping[str, object] | None) -> dict[str, object]:
    """Bound heartbeat metadata to small scalar operational counters."""
    if not stats:
        return {}
    output: dict[str, object] = {}
    for raw_key, raw_value in list(stats.items())[:20]:
        key = str(raw_key)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", key):
            continue
        if re.search(r"(?i)(password|pwd|token|secret|credential|api.?key)", key):
            continue
        if isinstance(raw_value, bool) or raw_value is None:
            output[key] = raw_value
        elif type(raw_value) in (int, float):
            output[key] = raw_value
        elif isinstance(raw_value, str):
            output[key] = " ".join(raw_value.replace("\x00", " ").split())[:120]
    return output


def _origin(value: str) -> str:
    raw = value.strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise GatiAuthError("the CaratOS API address is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise GatiAuthError("the CaratOS API address must be an HTTP(S) origin")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise GatiAuthError("the CaratOS API address must not contain credentials, query or fragment")
    if parsed.path not in {"", "/"}:
        raise GatiAuthError("the CaratOS API address must not contain a path")
    host = parsed.hostname.casefold()
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if parsed.scheme != "https" and not loopback:
        raise GatiAuthError("the CaratOS API address must use HTTPS outside loopback")
    default_port = (parsed.scheme == "https" and port in {None, 443}) or (
        parsed.scheme == "http" and port in {None, 80}
    )
    hostname = f"[{host}]" if ":" in host else host
    netloc = hostname if default_port else f"{hostname}:{port}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))
