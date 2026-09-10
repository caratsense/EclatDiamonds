"""Command-line entry point: python -m caratos_connect.cli ..."""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import platform
import re
from pathlib import Path

from .client import CaratOSClient
from .profile import ProfileError, load_profile
from .runner import discover, preview, printable, sync
from .secret_store import load_into_environment, save_secret_store


_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b("
    r"pwd|password|passphrase|token|authorization|user\s*id|uid|"
    r"client[\s_-]*secret|api[\s_-]*key|ssl[\s_-]*key|"
    r"(?:aws[\s_-]*)?(?:secret[\s_-]*)?access[\s_-]*key(?:[\s_-]*id)?"
    r")\s*[=:]\s*(\{(?:[^}]|}})*\}|\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^;\s]+)"
)


def main() -> int:
    parser = argparse.ArgumentParser(description="CaratOS profile-driven outbound Connect agent")
    parser.add_argument("--profile", required=True, help="Path to a reviewed JSON profile")
    parser.add_argument("--state-dir", default=os.environ.get("CONNECT_STATE_DIR", _default_state_dir()))
    parser.add_argument("--credential-file", default=os.environ.get("CONNECT_CREDENTIAL_FILE", ""))
    sub = parser.add_subparsers(dest="command", required=True)
    configure_parser = sub.add_parser("configure", help="Store credentials with Windows DPAPI")
    configure_parser.add_argument("--from-env", action="store_true", help="Read required values from this process environment")
    sub.add_parser("doctor", help="Check runtime, profile and required local driver; no source access")
    sub.add_parser("discover", help="List source schema/profile capabilities; no upload")
    preview_parser = sub.add_parser("preview", help="Map a bounded sample; no upload")
    preview_parser.add_argument("--limit", type=int, default=20)
    preview_parser.add_argument("--show-values", action="store_true")
    sync_parser = sub.add_parser("sync", help="Upload changed canonical master data")
    sync_parser.add_argument("--limit", type=int, default=5000)
    sync_parser.add_argument("--dry-run", action="store_true")
    sync_parser.add_argument(
        "--require-active",
        action="store_true",
        help="Fail if server policy disables the run (installer preflight)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    token = ""
    client = None
    profile = None
    try:
        profile = load_profile(args.profile)
        state_root = Path(args.state_dir).expanduser().resolve()
        credential_file = (
            Path(args.credential_file).expanduser().resolve()
            if args.credential_file
            else state_root.parent / "credentials" / f"{profile['id']}.bin"
        )
        if args.command == "configure":
            _configure(profile, credential_file, args.from_env)
            print(f"Stored DPAPI-protected connector values in {credential_file}")
            return 0
        if args.command == "doctor":
            print(printable(_doctor(profile)))
            return 0
        if credential_file.is_file():
            load_into_environment(credential_file, _credential_names(profile))
        if args.command == "discover":
            print(printable(discover(profile)))
            return 0
        if args.command == "preview":
            print(printable(preview(profile, _bounded(args.limit, 1, 100), args.show_values)))
            return 0
        base_url = _required("CARATOS_BASE_URL")
        token = _required("CARATOS_AGENT_TOKEN")
        client = CaratOSClient(base_url, token)
        result = sync(profile, client, state_root, _bounded(args.limit, 1, 5000), args.dry_run)
        print(printable(result))
        return _sync_exit_code(result, args.require_active)
    except Exception as exc:
        message = _safe_error(
            exc,
            token,
            *_profile_secret_values(profile),
        )
        if client is not None and _should_send_error_heartbeat(args):
            try:
                client.heartbeat("error", getattr(exc, "stats", {}), error=message)
            except Exception:
                pass
        print("ERROR: " + message)
        return 2


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _bounded(value: int, minimum: int, maximum: int) -> int:
    if value < minimum or value > maximum:
        raise ValueError(f"limit must be between {minimum} and {maximum}")
    return value


def _sync_exit_code(result: object, require_active: bool = False) -> int:
    if not isinstance(result, dict):
        return 2
    if result.get("phase") == "validation_failed":
        return 3
    if require_active and result.get("phase") == "disabled":
        return 4
    return 0


def _should_send_error_heartbeat(args: argparse.Namespace) -> bool:
    """Keep validation-only dry-runs free of connector status mutations."""
    return not (getattr(args, "command", None) == "sync" and bool(getattr(args, "dry_run", False)))


def _doctor(profile: dict) -> dict[str, object]:
    transport = profile["transport"]
    kind = transport["kind"]
    result: dict[str, object] = {
        "profile": profile["id"],
        "sourceSystem": profile["sourceSystem"],
        "transport": kind,
        "pythonVersion": platform.python_version(),
        "pythonArchitecture": platform.architecture()[0],
        "sourceAccessed": False,
        "uploadAttempted": False,
    }
    if kind not in {"access_file", "odbc"}:
        return result
    try:
        import pyodbc
    except ImportError as exc:
        raise RuntimeError("pyodbc is required for this connector profile") from exc
    drivers = list(pyodbc.drivers())
    result["visibleOdbcDrivers"] = drivers
    if kind == "access_file":
        expected = transport.get("driver", "Microsoft Access Driver (*.mdb, *.accdb)")
        result["requiredOdbcDriver"] = expected
        if expected not in drivers:
            raise RuntimeError(
                f"required ODBC driver is not visible to this {result['pythonArchitecture']} Python runtime"
            )
    return result


def _safe_error(error: Exception, *secrets: str) -> str:
    message = str(error)
    # Replace longer explicit values first so overlapping secrets cannot leave
    # a suffix behind. These include custom DSNs loaded from a profile.
    for secret in sorted({secret for secret in secrets if secret}, key=len, reverse=True):
        if secret:
            message = message.replace(secret, "[REDACTED]")
    message = _SECRET_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}=[REDACTED]",
        message,
    )
    message = re.sub(r"(?i)(https?://)[^/@\s]+@", r"\1[REDACTED]@", message)
    message = re.sub(r"(?i)bearer\s+[a-z0-9._~-]+", "Bearer [REDACTED]", message)
    return message[:2000]


def _profile_secret_values(profile: object) -> list[str]:
    values = [
        os.environ.get("CONNECT_SOURCE_DSN", ""),
        os.environ.get("CONNECT_SOURCE_PASSWORD", ""),
    ]
    if not isinstance(profile, dict):
        return values
    transport = profile.get("transport")
    if not isinstance(transport, dict):
        return values
    for key, env_name in transport.items():
        if not isinstance(env_name, str) or not key.endswith("Env"):
            continue
        if key in {"connectionEnv", "passwordEnv", "urlEnv"}:
            values.append(os.environ.get(env_name, ""))
    return values


def _default_state_dir() -> str:
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        return str(Path(local) / "CaratOS" / "Connect" / "state")
    return "state"


def _configure(profile: dict, path: Path, from_env: bool) -> None:
    values: dict[str, str] = {}
    for name in _credential_names(profile):
        existing = os.environ.get(name, "").strip()
        if from_env:
            if not existing:
                raise RuntimeError(f"{name} is required for --from-env")
            values[name] = existing
            continue
        label = f"{name}{' [leave blank to keep current process value]' if existing else ''}: "
        hidden = any(part in name for part in ("TOKEN", "PASSWORD", "DSN", "SECRET"))
        entered = (getpass.getpass(label) if hidden else input(label)).strip()
        value = entered or existing
        if not value:
            raise RuntimeError(f"{name} is required")
        values[name] = value
    save_secret_store(path, values)


def _credential_names(profile: dict) -> list[str]:
    names = ["CARATOS_BASE_URL", "CARATOS_AGENT_TOKEN"]
    transport = profile.get("transport", {})
    kind = transport.get("kind")
    keys = {
        "access_file": ("pathEnv", "passwordEnv"),
        "odbc": ("connectionEnv",),
        "tally_xml": ("urlEnv", "companyEnv"),
    }.get(kind, ())
    defaults = {
        "pathEnv": "CONNECT_SOURCE_FILE",
        "passwordEnv": "CONNECT_SOURCE_PASSWORD",
        "connectionEnv": "CONNECT_SOURCE_DSN",
        "urlEnv": "TALLY_URL",
        "companyEnv": "TALLY_COMPANY",
    }
    for key in keys:
        name = transport.get(key, defaults[key])
        if name not in names:
            names.append(name)
    return names


if __name__ == "__main__":
    raise SystemExit(main())
