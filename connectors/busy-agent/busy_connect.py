"""CaratOS Connect agent for BUSY customer masters.

Runs on the customer's Windows machine, reads BUSY .bds files through the
Microsoft Access ODBC driver, and pushes a canonical CSV outbound to CaratOS.
It never opens an inbound port and never stores a CaratOS user password.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import os
import platform
import shutil
import socket
import tempfile
import time
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import urlparse

import requests

VERSION = "0.2.0"
LOG = logging.getLogger("caratos.busy")
HEADERS = ["Customer Name", "Phone", "Email", "City", "GSTIN"]
MAPPINGS = [
    {"sourceColumn": "Customer Name", "canonicalField": "name"},
    {"sourceColumn": "Phone", "canonicalField": "phone"},
    {"sourceColumn": "Email", "canonicalField": "email"},
    {"sourceColumn": "City", "canonicalField": "city"},
    {"sourceColumn": "GSTIN", "canonicalField": "gstin"},
]


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def database_paths(raw: str) -> List[Path]:
    paths = [Path(part.strip()).expanduser() for part in raw.split(";") if part.strip()]
    if not paths:
        raise RuntimeError("BUSY_DB_PATHS contains no database paths")
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise RuntimeError("BUSY database not found: " + ", ".join(missing))
    return paths


def fingerprint(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha256(
        f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
    ).hexdigest()


def table_columns(cursor: Any, table: str) -> Dict[str, str]:
    cursor.execute(f"SELECT * FROM [{table}] WHERE 1=0")
    return {str(item[0]).lower(): str(item[0]) for item in cursor.description}


def choose_column(columns: Mapping[str, str], *candidates: str) -> str | None:
    for candidate in candidates:
        actual = columns.get(candidate.lower())
        if actual:
            return actual
    return None


def extract_customers(cursor: Any) -> List[Dict[str, str]]:
    """Read only Sundry Debtors; creditors are suppliers, not CRM customers."""
    columns = table_columns(cursor, "Master1")
    phone = choose_column(columns, "mobile", "phoneo", "phoner", "phone", "telno", "contactno")
    email = choose_column(columns, "email", "emailid", "e_mail")
    city = choose_column(columns, "city", "cityname")
    gstin = choose_column(columns, "gstin", "tinno", "tin", "regnno", "cstno", "vatno")

    selected: List[Tuple[str, str | None]] = [
        ("name", "a.[name]"),
        ("phone", f"a.[{phone}]" if phone else None),
        ("email", f"a.[{email}]" if email else None),
        ("city", f"a.[{city}]" if city else None),
        ("gstin", f"a.[{gstin}]" if gstin else None),
    ]
    query_columns = [expression for _, expression in selected if expression]
    cursor.execute(
        "SELECT " + ", ".join(query_columns) + " FROM [Master1] a "
        "LEFT JOIN [Master1] g ON a.[parentgrp] = g.[code] "
        "WHERE a.[mastertype] = 2 AND g.[name] LIKE '%Debtor%'"
    )

    included_keys = [key for key, expression in selected if expression]
    customers: List[Dict[str, str]] = []
    for raw in cursor.fetchall():
        row = {
            key: "" if value is None else str(value).strip()
            for key, value in zip(included_keys, raw)
        }
        if row.get("name"):
            customers.append(row)
    return customers


def csv_bytes(rows: Iterable[Mapping[str, str]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(HEADERS)
    for row in rows:
        writer.writerow(
            [row.get("name", ""), row.get("phone", ""), row.get("email", ""), row.get("city", ""), row.get("gstin", "")]
        )
    return output.getvalue().encode("utf-8-sig")


def open_busy_copy(path: Path, password: str) -> Tuple[Any, Path]:
    # BUSY may keep the live file locked. Work only on a private OS temp copy.
    handle, temporary_name = tempfile.mkstemp(prefix="caratos-busy-", suffix=".bds")
    os.close(handle)
    temporary = Path(temporary_name)
    shutil.copy2(path, temporary)
    try:
        import pypyodbc  # Imported lazily so helper tests run without Windows ODBC.

        connection = pypyodbc.connect(
            "Driver={Microsoft Access Driver (*.mdb, *.accdb)};"
            f"DBQ={temporary};pwd={password};"
        )
        return connection, temporary
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


class CaratOSClient:
    def __init__(self, base_url: str, token: str) -> None:
        if not token.startswith("cxa_"):
            raise RuntimeError("CARATOS_AGENT_TOKEN must be an enrolled cxa_ token")
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("CARATOS_BASE_URL must use HTTPS except for localhost testing")
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {token}"})

    def me(self) -> Mapping[str, Any]:
        response = self.session.get(f"{self.base_url}/integration/connect/me", timeout=30)
        response.raise_for_status()
        payload = response.json()
        if payload.get("sourceSystem") != "busy":
            raise RuntimeError("This Connect token is not enrolled for BUSY")
        return payload

    def upload(self, label: str, rows: Sequence[Mapping[str, str]], store_id: str | None) -> Mapping[str, Any]:
        response = self.session.post(
            f"{self.base_url}/imports/customers/run",
            data={
                "mappings": json.dumps(MAPPINGS),
                "sourceSystem": "busy",
                **({"storeId": store_id} if store_id else {}),
            },
            files={"file": (f"busy-{label}.csv", csv_bytes(rows), "text/csv")},
            timeout=180,
        )
        response.raise_for_status()
        return response.json()

    def heartbeat(self, status: str, stats: Mapping[str, Any], error: str | None = None, synced: bool = False) -> None:
        payload: Dict[str, Any] = {
            "agentVersion": VERSION,
            "hostname": socket.gethostname(),
            "os": platform.platform()[:120],
            "status": status,
            "stats": dict(stats),
        }
        if error:
            payload["error"] = error[:2000]
        if synced:
            payload["syncedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        response = self.session.post(f"{self.base_url}/integration/connect/heartbeat", json=payload, timeout=30)
        response.raise_for_status()


def load_state(path: Path) -> Dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: Mapping[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(dict(state), indent=2), encoding="utf-8")
    temporary.replace(path)


def sync_once(
    client: CaratOSClient,
    paths: Sequence[Path],
    password: str,
    state_file: Path,
    dry_run: bool = False,
) -> Dict[str, int]:
    identity = client.me()
    state = load_state(state_file)
    stats = {
        "databasesChecked": len(paths),
        "databasesChanged": 0,
        "customersRead": 0,
        "customersSubmitted": 0,
        "rowsImported": 0,
        "rowsUpdated": 0,
        "rowsDuplicate": 0,
        "rowsSkipped": 0,
        "rowsFailed": 0,
        "dryRun": int(dry_run),
    }
    for path in paths:
        current = fingerprint(path)
        key = str(path.resolve())
        if state.get(key) == current:
            continue
        connection = None
        temporary = None
        try:
            connection, temporary = open_busy_copy(path, password)
            rows = extract_customers(connection.cursor())
            stats["customersRead"] += len(rows)
            if dry_run:
                stats["databasesChanged"] += 1
                LOG.info("%s: validated %s customer rows (dry run; nothing uploaded)", path.name, len(rows))
                continue
            result = client.upload(path.stem, rows, identity.get("storeId"))
            counts = result.get("counts", {})
            stats["databasesChanged"] += 1
            stats["customersSubmitted"] += len(rows)
            stats["rowsImported"] += int(counts.get("imported", 0))
            stats["rowsUpdated"] += int(counts.get("updated", 0))
            stats["rowsDuplicate"] += int(counts.get("duplicate", 0))
            stats["rowsSkipped"] += int(counts.get("skipped", 0))
            stats["rowsFailed"] += int(counts.get("failed", 0))
            if int(counts.get("failed", 0)):
                raise RuntimeError(f"CaratOS rejected {counts['failed']} customer row(s); state was not advanced")
            state[key] = current
            save_state(state_file, state)
            LOG.info("%s: submitted %s customer rows", path.name, len(rows))
        finally:
            if connection is not None:
                connection.close()
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    client.heartbeat("active", stats, synced=not dry_run and stats["databasesChanged"] > 0)
    return stats


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def safe_error(error: Exception, *secrets: str) -> str:
    message = str(error)
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[REDACTED]")
    message = re.sub(r"(?i)(pwd|password)\s*=\s*[^;\s]+", r"\1=[REDACTED]", message)
    return message[:2000]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    LOG.error(
        "This legacy BUSY agent is retired. Use connectors/connect-agent with "
        "profiles/busy-bds-starter.json; the hardened import contract intentionally "
        "rejects this older client."
    )
    return 2
    # Kept below only as historical implementation reference for existing tests.
    try:
        base_url = required_env("CARATOS_BASE_URL")
        token = required_env("CARATOS_AGENT_TOKEN")
        password = required_env("BUSY_DB_PASSWORD")
        paths = database_paths(required_env("BUSY_DB_PATHS"))
        state_root = Path(os.environ.get("BUSY_STATE_DIR", Path(os.environ.get("LOCALAPPDATA", ".")) / "CaratOS" / "BusyAgent"))
        interval = max(60, int(os.environ.get("BUSY_INTERVAL_SECONDS", "300")))
        run_once = env_flag("BUSY_RUN_ONCE")
        dry_run = env_flag("BUSY_DRY_RUN")
        client = CaratOSClient(base_url, token)
        while True:
            try:
                sync_once(client, paths, password, state_root / "state.json", dry_run=dry_run)
            except Exception as exc:
                message = safe_error(exc, token, password)
                LOG.error("BUSY sync failed: %s", message)
                try:
                    client.heartbeat("error", {}, error=message)
                except Exception:
                    LOG.error("Could not report agent failure to CaratOS")
                if run_once:
                    return 1
            if run_once:
                return 0
            time.sleep(interval)
    except (RuntimeError, ValueError) as exc:
        LOG.error("Configuration error: %s", exc)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
