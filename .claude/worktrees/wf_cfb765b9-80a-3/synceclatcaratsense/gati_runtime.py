"""Small crash-safety primitives shared by every legacy Gati command.

The lock is held by the operating system, not by the contents of a sentinel
file.  A crash therefore releases it automatically.  Keeping one lock path for
data, media and website catalogue jobs prevents a manual command from racing
the scheduled data job over local checkpoints or a shared agent heartbeat.
"""

from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Mapping


ROOT = Path(__file__).resolve().parent
RUN_LOCK = ROOT / ".gati-sync.lock"


class GatiRunAlreadyActive(RuntimeError):
    """Raised when another process owns the install-wide Gati run lock."""


def atomic_write_json(path: str | os.PathLike[str], value: Mapping) -> None:
    """Durably replace a JSON object without exposing a truncated destination."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


@contextmanager
def install_run_lock(job: str) -> Iterator[None]:
    """Acquire the package-wide non-blocking process lock.

    The small file is intentionally retained between runs; ownership is the OS
    byte-range/flock, so stale file contents can never leave the adapter locked.
    """

    RUN_LOCK.parent.mkdir(parents=True, exist_ok=True)
    handle = open(RUN_LOCK, "a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError) as exc:
            raise GatiRunAlreadyActive(
                f"another Gati command is already running from this installation; "
                f"{job} did not start"
            ) from exc

        try:
            yield
        finally:
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                # Closing the descriptor below is the authoritative OS release.
                pass
    finally:
        handle.close()
