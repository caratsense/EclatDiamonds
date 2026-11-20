"""Windows DPAPI-backed per-user connector secret storage."""

from __future__ import annotations

import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path
from typing import Collection, Mapping


class SecretStoreError(RuntimeError):
    pass


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


_DESCRIPTION = "CaratOS Connect credentials"
_ENTROPY = b"CaratOS Connect secret store v1"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


def save_secret_store(path: Path, values: Mapping[str, str]) -> None:
    cleaned = {str(key): str(value) for key, value in values.items() if str(value)}
    if not cleaned:
        raise SecretStoreError("no connector values were supplied")
    plaintext = json.dumps(cleaned, separators=(",", ":")).encode("utf-8")
    encrypted = _protect(plaintext)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        temporary.write_bytes(encrypted)
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_secret_store(path: Path) -> dict[str, str]:
    try:
        encrypted = path.read_bytes()
    except FileNotFoundError as exc:
        raise SecretStoreError(f"credential store not found: {path}") from exc
    try:
        decoded = json.loads(_unprotect(encrypted).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SecretStoreError("credential store is corrupt or belongs to another Windows user") from exc
    if not isinstance(decoded, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in decoded.items()
    ):
        raise SecretStoreError("credential store has an invalid shape")
    return decoded


def load_into_environment(path: Path, required_names: Collection[str]) -> None:
    """Expose decrypted values only to this process; never persist user env vars."""
    values = load_secret_store(path)
    expected = set(required_names)
    missing = sorted(expected - set(values))
    unexpected = sorted(set(values) - expected)
    if missing:
        raise SecretStoreError(f"credential store is missing required values: {', '.join(missing)}")
    if unexpected:
        raise SecretStoreError(f"credential store contains unexpected values: {', '.join(unexpected)}")
    for key in expected:
        # The reviewed DPAPI vault is authoritative. Inherited user environment
        # variables may be stale plaintext from an older installation.
        os.environ[key] = values[key]


def _protect(data: bytes) -> bytes:
    _require_windows()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(_ENTROPY)
    target = _DataBlob()
    # Keep buffers alive through the native call.
    _ = (source_buffer, entropy_buffer)
    ok = crypt32.CryptProtectData(
        ctypes.byref(source),
        _DESCRIPTION,
        ctypes.byref(entropy),
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(target),
    )
    if not ok:
        raise SecretStoreError(f"Windows DPAPI encryption failed ({ctypes.get_last_error()})")
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        kernel32.LocalFree(target.pbData)


def _unprotect(data: bytes) -> bytes:
    _require_windows()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(_ENTROPY)
    target = _DataBlob()
    description = wintypes.LPWSTR()
    _ = (source_buffer, entropy_buffer)
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source),
        ctypes.byref(description),
        ctypes.byref(entropy),
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(target),
    )
    if not ok:
        raise SecretStoreError(f"Windows DPAPI decryption failed ({ctypes.get_last_error()})")
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        if description:
            kernel32.LocalFree(description)
        kernel32.LocalFree(target.pbData)


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _require_windows() -> None:
    if os.name != "nt":
        raise SecretStoreError("the production credential store requires Windows DPAPI")
