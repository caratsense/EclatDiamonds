"""Crash-safe, identity-scoped connector checkpoints and process locking."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence


class StateError(RuntimeError):
    """A checkpoint cannot be trusted and must be reviewed, not silently reset."""


class AlreadyRunningError(StateError):
    """Another process already owns this exact agent/profile checkpoint."""


def rows_fingerprint(rows: Sequence[Mapping[str, Any]]) -> str:
    """Hash canonical rows independent of nondeterministic database row order."""
    encoded_rows = [
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        for row in rows
    ]
    encoded = "[" + ",".join(sorted(encoded_rows)) + "]"
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def checkpoint_key(
    identity: Mapping[str, Any],
    profile_hash: str,
    source_instance_hash: str,
    entity: str,
) -> str:
    material = "|".join(
        [
            str(identity.get("organisationId", "")),
            str(identity.get("agentId", "")),
            str(identity.get("storeId") or "organisation"),
            profile_hash,
            source_instance_hash,
            entity,
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def state_file_for(
    root: Path,
    identity: Mapping[str, Any],
    profile_id: str,
    profile_hash: str,
    source_instance_hash: str,
) -> Path:
    """Keep different tenants, agents, stores, profiles and companies isolated."""
    namespace = checkpoint_key(identity, profile_hash, source_instance_hash, "state")[:24]
    return root / f"{profile_id}-{namespace}.json"


def load_state(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        raise StateError(
            f"checkpoint {path.name!r} is unreadable; quarantine or restore it before syncing"
        ) from exc
    if not isinstance(value, dict) or any(
        not isinstance(key, str) or not isinstance(item, str) for key, item in value.items()
    ):
        raise StateError(f"checkpoint {path.name!r} has an invalid shape")
    return dict(value)


def save_state(path: Path, state: Mapping[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=path.name + ".",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            json.dump(dict(state), temporary, indent=2, sort_keys=True)
            temporary.flush()
            os.fsync(temporary.fileno())
        try:
            os.chmod(temporary_name, 0o600)
        except OSError:
            pass
        os.replace(temporary_name, path)
    finally:
        if temporary_name:
            try:
                Path(temporary_name).unlink(missing_ok=True)
            except OSError:
                pass


@contextmanager
def state_lock(state_file: Path) -> Iterator[None]:
    """Hold an OS-released advisory lock for one complete profile run."""
    state_file.parent.mkdir(parents=True, exist_ok=True)
    lock_path = state_file.with_suffix(state_file.suffix + ".lock")
    handle = lock_path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        _lock(handle)
        yield
    finally:
        try:
            handle.seek(0)
            _unlock(handle)
        finally:
            handle.close()


def _lock(handle: Any) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        raise AlreadyRunningError("this agent/profile sync is already running") from exc


def _unlock(handle: Any) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        # Process exit also releases the OS lock; an unlock error must not hide
        # the actual sync result.
        pass
