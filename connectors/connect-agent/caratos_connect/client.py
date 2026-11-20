"""Narrow, retry-safe CaratOS API client for an enrolled machine principal."""

from __future__ import annotations

import csv
import ipaddress
import io
import json
import platform
import random
import socket
import time
from email.utils import parsedate_to_datetime
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

import requests

from . import VERSION
from .profile import ProfileError, normalize_origin_url


MAX_UPLOAD_BYTES = 7 * 1024 * 1024
TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}


class CaratOSClient:
    def __init__(self, base_url: str, token: str) -> None:
        try:
            normalized_url = normalize_origin_url(base_url, "CARATOS_BASE_URL")
        except ProfileError as exc:
            raise RuntimeError(str(exc)) from exc
        parsed = urlsplit(normalized_url)
        if parsed.scheme != "https" and not _is_loopback_host(parsed.hostname or ""):
            raise RuntimeError("CARATOS_BASE_URL must use HTTPS except for loopback hosts")
        if not token.startswith("cxa_"):
            raise RuntimeError("CARATOS_AGENT_TOKEN must be an enrolled cxa_ token")
        self.base_url = normalized_url
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {token}"})

    def me(self, expected_source: str) -> Mapping[str, Any]:
        response = self._request("GET", "/integration/connect/me", retry_safe=True, timeout=30)
        identity = response.json()
        if identity.get("sourceSystem") != expected_source:
            raise RuntimeError(
                f"Connect token is enrolled for {identity.get('sourceSystem')!r}, not {expected_source!r}"
            )
        return identity

    def validate(
        self,
        source: str,
        profile_id: str,
        entity: str,
        rows: Sequence[Mapping[str, str]],
        store_id: str | None,
        profile_hash: str,
        source_instance_hash: str,
    ) -> Mapping[str, Any]:
        columns, payload = _payload(rows)
        response = self._request(
            "POST",
            f"/imports/{entity}/preview",
            retry_safe=True,
            data={
                "mappings": json.dumps(_mappings(columns)),
                "sourceSystem": source,
                "profileId": profile_id,
                "profileHash": profile_hash,
                "sourceInstanceHash": source_instance_hash,
                **({"storeId": store_id} if store_id else {}),
            },
            files={"file": (f"{source}-{profile_id}-{entity}.csv", payload, "text/csv")},
            timeout=180,
        )
        return response.json()

    def upload(
        self,
        source: str,
        profile_id: str,
        entity: str,
        rows: Sequence[Mapping[str, str]],
        store_id: str | None,
        run_key: str,
        profile_hash: str,
        source_instance_hash: str,
        config_revision: str,
    ) -> Mapping[str, Any]:
        columns, payload = _payload(rows)
        response = self._request(
            "POST",
            f"/imports/{entity}/run",
            # Safe only because the server persists and uniquely enforces runKey.
            retry_safe=True,
            data={
                "mappings": json.dumps(_mappings(columns)),
                "sourceSystem": source,
                "runKey": run_key,
                "profileId": profile_id,
                "profileHash": profile_hash,
                "sourceInstanceHash": source_instance_hash,
                "configRevision": config_revision,
                **({"storeId": store_id} if store_id else {}),
            },
            files={"file": (f"{source}-{profile_id}-{entity}.csv", payload, "text/csv")},
            timeout=180,
        )
        return response.json()

    def heartbeat(
        self,
        status: str,
        stats: Mapping[str, Any],
        error: str | None = None,
        synced: bool = False,
    ) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "agentVersion": f"connect-agent/{VERSION}",
            "hostname": socket.gethostname(),
            "os": platform.platform()[:120],
            "status": status,
            "stats": dict(stats),
        }
        if error:
            payload["error"] = error[:2000]
        if synced:
            payload["syncedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        response = self._request(
            "POST", "/integration/connect/heartbeat", retry_safe=True, json=payload, timeout=30
        )
        return response.json()

    def _request(
        self,
        method: str,
        path: str,
        *,
        retry_safe: bool,
        attempts: int = 3,
        **kwargs: Any,
    ) -> requests.Response:
        last_error: Exception | None = None
        # Never replay an authenticated request or customer CSV at a redirect
        # target. The configured base URL itself must be the final API origin.
        kwargs["allow_redirects"] = False
        for attempt in range(attempts):
            try:
                response = self.session.request(method, f"{self.base_url}{path}", **kwargs)
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_error = exc
                if not retry_safe or attempt + 1 >= attempts:
                    raise
                time.sleep(_retry_delay(None, attempt))
                continue
            if 300 <= response.status_code < 400:
                _close_response(response)
                raise RuntimeError("CaratOS API redirects are not allowed")
            transient = response.status_code in TRANSIENT_STATUS or 500 <= response.status_code <= 599
            if retry_safe and transient and attempt + 1 < attempts:
                retry_after = response.headers.get("Retry-After")
                _close_response(response)
                time.sleep(_retry_delay(retry_after, attempt))
                continue
            response.raise_for_status()
            return response
        if last_error:
            raise last_error
        raise RuntimeError("CaratOS request exhausted its retry budget")


def _is_loopback_host(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return False
    if address.is_loopback:
        return True
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


def _close_response(response: requests.Response) -> None:
    try:
        response.close()
    except Exception:
        # Closing is best-effort for unusual adapters and lightweight test
        # responses; the response is never reused after this point.
        pass


def _payload(rows: Sequence[Mapping[str, str]]) -> tuple[list[str], bytes]:
    columns = _columns(rows)
    payload = csv_bytes(columns, rows)
    if len(payload) > MAX_UPLOAD_BYTES:
        raise RuntimeError(
            "canonical upload exceeds the safe 7 MiB limit; add reviewed deterministic pagination"
        )
    return columns, payload


def _mappings(columns: Sequence[str]) -> list[dict[str, str]]:
    return [{"sourceColumn": field, "canonicalField": field} for field in columns]


def _columns(rows: Sequence[Mapping[str, str]]) -> list[str]:
    return sorted({field for row in rows for field in row})


def csv_bytes(columns: Sequence[str], rows: Sequence[Mapping[str, str]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=list(columns), extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def _retry_delay(retry_after: str | None, attempt: int) -> float:
    if retry_after:
        try:
            return min(30.0, max(0.0, float(retry_after)))
        except ValueError:
            try:
                seconds = parsedate_to_datetime(retry_after).timestamp() - time.time()
                return min(30.0, max(0.0, seconds))
            except (TypeError, ValueError, OverflowError):
                pass
    return min(5.0, (0.25 * (2**attempt)) + random.uniform(0.0, 0.25))
