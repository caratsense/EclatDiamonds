"""Explicit network-target approval for the Eclat Gati package.

The package is intentionally easy to run by double-clicking a batch file. That
also makes a stale production URL dangerous on a developer machine. Networked
commands therefore require two independently named settings to normalize to the
same target: the address to use and the address a person approved in step 2.

This module contains no defaults and never reads or writes the credential file.
"""

from __future__ import annotations

import ipaddress
import os
import sys
from urllib.parse import SplitResult, urlsplit, urlunsplit


class TargetSafetyError(RuntimeError):
    """Raised before network access when a target is absent or unapproved."""


def _parsed(value: str, label: str) -> tuple[SplitResult, int | None]:
    raw = (value or "").strip()
    if not raw:
        raise TargetSafetyError(f"{label} is missing; run 2_configure.bat")
    if any(ord(char) < 32 for char in raw) or "\\" in raw or any(char.isspace() for char in raw):
        raise TargetSafetyError(f"{label} is malformed")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise TargetSafetyError(f"{label} is malformed") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise TargetSafetyError(f"{label} must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise TargetSafetyError(f"{label} must not contain credentials or a fragment")
    return parsed, port


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.casefold() == "localhost"


def _netloc(parsed: SplitResult, port: int | None) -> str:
    host = parsed.hostname.casefold()
    default_port = (parsed.scheme == "https" and port in {None, 443}) or (
        parsed.scheme == "http" and port in {None, 80}
    )
    rendered_host = f"[{host}]" if ":" in host else host
    return rendered_host if default_port else f"{rendered_host}:{port}"


def normalize_backend_origin(value: str) -> str:
    parsed, port = _parsed(value, "CaratOS backend target")
    if parsed.query or parsed.path not in {"", "/"}:
        raise TargetSafetyError("CaratOS backend target must be an origin without path or query")
    if parsed.scheme != "https" and not _is_loopback(parsed.hostname):
        raise TargetSafetyError("CaratOS backend target must use HTTPS outside loopback")
    return urlunsplit((parsed.scheme, _netloc(parsed, port), "", "", ""))


def normalize_website_endpoint(value: str) -> str:
    parsed, port = _parsed(value, "website API target")
    if parsed.scheme != "https" and not _is_loopback(parsed.hostname):
        raise TargetSafetyError("website API target must use HTTPS outside loopback")
    if not parsed.path or parsed.path == "/":
        raise TargetSafetyError("website API target must include its explicit API path")
    return urlunsplit(
        (parsed.scheme, _netloc(parsed, port), parsed.path, parsed.query, "")
    )


def normalize_website_origin(value: str) -> str:
    parsed, port = _parsed(value, "website public origin")
    if parsed.query or parsed.path not in {"", "/"}:
        raise TargetSafetyError("website public origin must not contain path or query")
    if parsed.scheme != "https" and not _is_loopback(parsed.hostname):
        raise TargetSafetyError("website public origin must use HTTPS outside loopback")
    return urlunsplit((parsed.scheme, _netloc(parsed, port), "", "", ""))


def require_approved_backend(target: str, approved: str) -> str:
    normalized = normalize_backend_origin(target)
    if not (approved or "").strip():
        raise TargetSafetyError(
            "CARATOS_APPROVED_BACKEND_ORIGIN is missing; rerun 2_configure.bat and review the target"
        )
    if normalize_backend_origin(approved) != normalized:
        raise TargetSafetyError(
            "CaratOS backend target does not match the explicitly approved origin"
        )
    return normalized


def require_approved_website(target: str, approved: str, public_origin: str) -> tuple[str, str]:
    normalized = normalize_website_endpoint(target)
    if not (approved or "").strip():
        raise TargetSafetyError(
            "ECLAT_APPROVED_WEBSITE_API is missing; rerun 2_configure.bat and review the website feed"
        )
    if normalize_website_endpoint(approved) != normalized:
        raise TargetSafetyError("website API target does not match the explicitly approved endpoint")
    return normalized, normalize_website_origin(public_origin)


def approved_backend_from_env() -> str:
    return require_approved_backend(
        os.getenv("ECLAT_BASE_URL", ""),
        os.getenv("CARATOS_APPROVED_BACKEND_ORIGIN", ""),
    )


def approved_website_from_env() -> tuple[str, str]:
    return require_approved_website(
        os.getenv("ECLAT_WEBSITE_API", ""),
        os.getenv("ECLAT_APPROVED_WEBSITE_API", ""),
        os.getenv("ECLAT_WEBSITE_ORIGIN", ""),
    )


def main(argv: list[str] | None = None) -> int:
    requested = (argv if argv is not None else sys.argv[1:]) or ["backend"]
    try:
        for target_type in requested:
            if target_type == "backend":
                approved_backend_from_env()
                print("[OK] Explicit CaratOS backend target approval verified.")
            elif target_type == "website":
                approved_website_from_env()
                print("[OK] Explicit website API target approval verified.")
            else:
                raise TargetSafetyError("usage: gati_target_safety.py [backend] [website]")
    except TargetSafetyError as exc:
        print(f"[SAFETY STOP] {exc}", file=sys.stderr)
        return 20
    return 0


if __name__ == "__main__":
    sys.exit(main())
