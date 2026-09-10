"""Discovery, server-validated preview and idempotent outbound sync orchestration."""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

from . import VERSION
from .client import CaratOSClient
from .mapping import map_rows_detailed
from .profile import profile_fingerprint, source_instance_fingerprint
from .sources import source_for
from .state import (
    checkpoint_key,
    load_state,
    rows_fingerprint,
    save_state,
    state_file_for,
    state_lock,
)

LOG = logging.getLogger("caratos.connect")
PROTOCOL_VERSION = 1


class SyncFailure(RuntimeError):
    def __init__(self, message: str, stats: Mapping[str, Any]) -> None:
        super().__init__(message)
        self.stats = dict(stats)


def discover(profile: Mapping[str, Any]) -> Mapping[str, Any]:
    with source_for(profile) as source:
        return source.discover()


def preview(profile: Mapping[str, Any], limit: int = 20, show_values: bool = False) -> Mapping[str, Any]:
    output: dict[str, Any] = {
        "profile": profile["id"],
        "profileHash": profile_fingerprint(profile),
        "sourceInstanceHash": source_instance_fingerprint(profile),
        "sourceSystem": profile["sourceSystem"],
        "entities": {},
    }
    with source_for(profile) as source:
        for entity, definition in profile.get("entities", {}).items():
            # Preview is deliberately a bounded sample. Real sync keeps the
            # default overflow check and refuses silently truncated sources.
            raw = source.extract(definition, limit, False)
            rows, issues, filtered = map_rows_detailed(definition, raw)
            output["entities"][entity] = {
                "read": len(raw),
                "filtered": filtered,
                "ready": len(rows),
                "rejected": len(issues),
                "allowEmpty": definition.get("allowEmpty") is True,
                "issues": issues[:20],
                "sample": rows[:5] if show_values else [_mask(row) for row in rows[:5]],
            }
    return output


def sync(
    profile: Mapping[str, Any],
    client: CaratOSClient,
    state_root: Path,
    limit: int = 5000,
    dry_run: bool = False,
    identity: Mapping[str, Any] | None = None,
) -> Mapping[str, Any]:
    if profile.get("discoveryOnly") or not profile.get("entities"):
        raise RuntimeError("discovery-only profiles cannot run sync")
    identity = identity or client.me(profile["sourceSystem"])
    profile_hash = profile_fingerprint(profile)
    _validate_handshake(
        identity,
        profile_hash,
        require_approval=not dry_run and identity.get("enabled") is not False,
    )
    stats: dict[str, Any] = {
        "profile": profile["id"],
        "profileHash": profile_hash,
        "phase": "starting",
        "entitiesChecked": 0,
        "entitiesChanged": 0,
        "rowsRead": 0,
        "rowsFiltered": 0,
        "rowsReady": 0,
        "rowsRejectedLocally": 0,
        "rowsServerValid": 0,
        "rowsServerWarning": 0,
        "rowsServerError": 0,
        "rowsImported": 0,
        "rowsUpdated": 0,
        "rowsDuplicate": 0,
        "rowsFailed": 0,
        "dryRun": dry_run,
    }
    if identity["enabled"] is False:
        stats.update({"phase": "disabled", "disabled": True})
        if not dry_run:
            client.heartbeat("active", stats)
        return stats

    configured_limit = identity.get("batchSize", 5000)
    if isinstance(configured_limit, bool) or not isinstance(configured_limit, int):
        raise SyncFailure("server returned an invalid batchSize", stats)
    if not 1 <= configured_limit <= 5000:
        raise SyncFailure("server batchSize is outside the supported range 1..5000", stats)
    effective_limit = min(limit, configured_limit)
    try:
        source_hash = source_instance_fingerprint(profile)
        _validate_source_handshake(
            identity,
            source_hash,
            require_approval=not dry_run,
        )
        stats["sourceInstanceHash"] = source_hash
        pinned_source = identity.get("sourceInstanceHash")
        if pinned_source and pinned_source != source_hash:
            raise RuntimeError(
                "this agent is pinned to a different source connection descriptor; enrol a separate agent"
            )
        state_file = state_file_for(
            Path(state_root), identity, profile["id"], profile_hash, source_hash
        )
        with state_lock(state_file):
            return _sync_locked(
                profile,
                client,
                state_file,
                identity,
                profile_hash,
                source_hash,
                stats,
                effective_limit,
                dry_run,
            )
    except SyncFailure:
        raise
    except Exception as exc:
        raise SyncFailure(str(exc), stats) from exc


def _sync_locked(
    profile: Mapping[str, Any],
    client: CaratOSClient,
    state_file: Path,
    identity: Mapping[str, Any],
    profile_hash: str,
    source_hash: str,
    stats: dict[str, Any],
    limit: int,
    dry_run: bool,
) -> Mapping[str, Any]:
    state = load_state(state_file)
    config_revision = _config_revision(identity)
    schedule_key = checkpoint_key(
        identity,
        profile_hash,
        source_hash,
        f"schedule:{config_revision}",
    )
    if not dry_run:
        try:
            next_sync = float(state.get(schedule_key, "0"))
        except ValueError as exc:
            raise RuntimeError("checkpoint contains an invalid next-sync time") from exc
        if next_sync > time.time():
            stats["phase"] = "not_due"
            client.heartbeat("active", stats)
            return stats

    # A dry-run is validation-only. Identity and validation calls are enough;
    # avoid extra heartbeats so the connector itself creates no status events.
    policy = identity if dry_run else client.heartbeat("active", stats)
    if _policy_enabled(policy) is False:
        stats.update({"phase": "disabled", "disabled": True})
        return stats
    with source_for(profile) as source:
        for entity, definition in profile.get("entities", {}).items():
            stats["phase"] = "extracting"
            stats["entity"] = entity
            stats["entitiesChecked"] += 1
            raw = source.extract(definition, limit)
            rows, issues, filtered = map_rows_detailed(definition, raw)
            _namespace_identities(
                rows,
                entity,
                str(profile["sourceSystem"]),
                source_hash,
            )
            rows.sort(key=_canonical_row_key)
            stats["rowsRead"] += len(raw)
            stats["rowsFiltered"] += filtered
            stats["rowsReady"] += len(rows)
            stats["rowsRejectedLocally"] += len(issues)
            if len(raw) != filtered + len(rows) + len(issues):
                raise RuntimeError("local row accounting invariant failed")
            if issues and not dry_run:
                raise RuntimeError(
                    f"local mapping rejected {len(issues)} {entity} row(s); preview and correct the profile"
                )
            if not rows and definition.get("allowEmpty") is not True:
                reason = (
                    "all source rows were filtered or rejected"
                    if raw
                    else "the source returned no rows"
                )
                raise RuntimeError(
                    f"{entity} preflight failed because {reason}; set allowEmpty=true only after reviewing this entity"
                )

            fingerprint = rows_fingerprint(rows)
            # configRevision is the server-controlled sync generation. Bumping
            # it forces a new receipt after a restore/PITR even when source rows
            # and the local profile itself have not changed.
            state_key = checkpoint_key(
                identity, profile_hash, source_hash, f"{entity}:{config_revision}"
            )
            if state.get(state_key) == fingerprint and not dry_run:
                continue
            stats["entitiesChanged"] += 1

            # A run key identifies one persisted delivery attempt, not merely
            # one set of row bytes. A random UUID prevents an old server receipt
            # from being replayed after local state loss. The pending record is
            # written before upload and retained across ambiguous failures.
            pending_key = checkpoint_key(
                identity,
                profile_hash,
                source_hash,
                f"pending:{entity}:{config_revision}",
            )

            warning = 0
            server_errors = 0
            if rows:
                result = client.validate(
                    profile["sourceSystem"],
                    profile["id"],
                    entity,
                    rows,
                    identity.get("storeId"),
                    profile_hash,
                    source_hash,
                )
                valid, warning, server_errors = _validation_counts(result, len(rows))
                stats["rowsServerValid"] += valid
                stats["rowsServerWarning"] += warning
                stats["rowsServerError"] += server_errors
            if server_errors and not dry_run:
                raise RuntimeError(
                    f"server validation rejected {server_errors} {entity} row(s); state not advanced"
                )
            if warning and not dry_run:
                raise RuntimeError(
                    f"server validation held {warning} warning {entity} row(s); state not advanced"
                )

            if dry_run:
                continue

            if rows:
                attempt_id = _pending_attempt_uuid(
                    state,
                    state_file,
                    pending_key,
                    fingerprint,
                )
                run_key = _run_key(
                    identity,
                    profile_hash,
                    source_hash,
                    entity,
                    fingerprint,
                    config_revision,
                    attempt_id,
                )
                result = client.upload(
                    profile["sourceSystem"],
                    profile["id"],
                    entity,
                    rows,
                    identity.get("storeId"),
                    run_key,
                    profile_hash,
                    source_hash,
                    config_revision,
                )
                (
                    discovered,
                    imported,
                    updated,
                    skipped,
                    duplicate,
                    failed,
                ) = _upload_counts(result, len(rows))
                stats["rowsImported"] += imported
                stats["rowsUpdated"] += updated
                stats["rowsDuplicate"] += duplicate
                stats["rowsFailed"] += failed
                if skipped or failed or duplicate:
                    raise RuntimeError(
                        f"CaratOS held {skipped + failed + duplicate} skipped/ambiguous/failed {entity} row(s); state not advanced"
                    )
            # Commit the accepted fingerprint and removal of its pending UUID
            # in one atomic checkpoint replacement. If this write fails after
            # the server accepted the upload, the pending UUID survives and the
            # next run safely asks for the same receipt.
            state[state_key] = fingerprint
            state.pop(pending_key, None)
            save_state(state_file, state)
            policy = client.heartbeat("active", stats, synced=bool(rows))
            if _policy_enabled(policy) is False:
                stats.update({"phase": "disabled", "disabled": True})
                return stats

    stats.pop("entity", None)
    stats["phase"] = (
        "validation_failed"
        if dry_run
        and (
            stats["rowsRejectedLocally"]
            or stats["rowsServerWarning"]
            or stats["rowsServerError"]
        )
        else "complete"
    )
    if not dry_run:
        interval = identity.get("syncIntervalMinutes", 15)
        if isinstance(interval, bool) or not isinstance(interval, int) or not 5 <= interval <= 1440:
            raise RuntimeError("server returned an invalid syncIntervalMinutes")
        state[schedule_key] = str(time.time() + interval * 60)
        save_state(state_file, state)
    if not dry_run:
        client.heartbeat("active", stats, synced=stats["entitiesChanged"] > 0)
    return stats


def _validation_counts(result: Mapping[str, Any], expected: int) -> tuple[int, int, int]:
    values = []
    for key in ("total", "valid", "warning", "error"):
        value = result.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise RuntimeError(f"server validation returned an invalid {key} count")
        values.append(value)
    total, valid, warning, error = values
    if total != expected or total != valid + warning + error:
        raise RuntimeError("server validation row accounting invariant failed")
    return valid, warning, error


def _upload_counts(
    result: Mapping[str, Any], expected: int
) -> tuple[int, int, int, int, int, int]:
    counts = result.get("counts")
    if not isinstance(counts, Mapping):
        raise RuntimeError("server upload returned no trustworthy row counts; state not advanced")
    values: list[int] = []
    for key in ("discovered", "imported", "updated", "skipped", "duplicate", "failed"):
        value = counts.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise RuntimeError(
                f"server upload returned an invalid {key} count; state not advanced"
            )
        values.append(value)
    discovered, imported, updated, skipped, duplicate, failed = values
    if discovered != expected:
        raise RuntimeError(
            "server upload acknowledged a different row count; state not advanced"
        )
    if discovered != imported + updated + skipped + duplicate + failed:
        raise RuntimeError("server row accounting invariant failed; state not advanced")
    return discovered, imported, updated, skipped, duplicate, failed


def printable(value: Mapping[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _validate_handshake(
    identity: Mapping[str, Any],
    profile_hash: str,
    *,
    require_approval: bool,
) -> None:
    protocol = identity.get("protocolVersion")
    if protocol != PROTOCOL_VERSION:
        raise RuntimeError(
            f"unsupported Connect protocol {protocol!r}; agent requires {PROTOCOL_VERSION}"
        )
    minimum = str(identity.get("minimumAgentVersion", "0.0.0"))
    maximum = str(identity.get("maximumAgentVersion", "9999.0.0"))
    if not (_version_tuple(minimum) <= _version_tuple(VERSION) <= _version_tuple(maximum)):
        raise RuntimeError(
            f"agent version {VERSION} is outside the server-supported range {minimum}..{maximum}"
        )
    enabled = _policy_enabled(identity)
    _config_revision(identity)
    expected = identity.get("expectedProfileHash")
    if expected is not None and (
        not isinstance(expected, str)
        or len(expected) != 64
        or any(character not in "0123456789abcdef" for character in expected)
    ):
        raise RuntimeError("server returned an invalid approved profile hash")
    if expected and expected != profile_hash:
        raise RuntimeError("local connector profile does not match the server-approved profile hash")
    if require_approval and enabled and expected != profile_hash:
        raise RuntimeError(
            "live sync requires this exact connector profile hash to be approved in CaratOS"
        )


def _policy_enabled(policy: Mapping[str, Any]) -> bool:
    enabled = policy.get("enabled")
    if not isinstance(enabled, bool):
        raise RuntimeError("server returned an invalid enabled policy")
    return enabled


def _validate_source_handshake(
    identity: Mapping[str, Any],
    source_hash: str,
    require_approval: bool,
) -> None:
    expected = identity.get("expectedSourceInstanceHash")
    if expected is not None and (
        not isinstance(expected, str)
        or len(expected) != 64
        or any(character not in "0123456789abcdef" for character in expected)
    ):
        raise RuntimeError("server returned an invalid approved source descriptor hash")
    if expected and expected != source_hash:
        raise RuntimeError(
            "local source descriptor does not match the server-approved descriptor hash"
        )
    if require_approval and expected != source_hash:
        raise RuntimeError(
            "live sync requires this exact source descriptor hash to be approved in CaratOS"
        )


def _config_revision(identity: Mapping[str, Any]) -> str:
    revision = identity.get("configRevision")
    if (
        not isinstance(revision, str)
        or not revision
        or len(revision) > 80
        or any(not (character.isalnum() or character in "._-") for character in revision)
    ):
        raise RuntimeError("server returned an invalid configRevision")
    return revision


def _version_tuple(value: str) -> tuple[int, int, int]:
    raw = value.removeprefix("connect-agent/").split("-", 1)[0].split(".")
    try:
        parts = [int(item) for item in raw]
    except ValueError as exc:
        raise RuntimeError(f"server returned invalid agent version {value!r}") from exc
    if not 1 <= len(parts) <= 3:
        raise RuntimeError(f"server returned invalid agent version {value!r}")
    return tuple((parts + [0, 0, 0])[:3])  # type: ignore[return-value]


def _run_key(
    identity: Mapping[str, Any],
    profile_hash: str,
    source_hash: str,
    entity: str,
    fingerprint: str,
    config_revision: str,
    attempt_id: str,
) -> str:
    material = "|".join(
        [
            str(identity.get("agentId", "")),
            profile_hash,
            source_hash,
            entity,
            config_revision,
            attempt_id,
            fingerprint,
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _pending_attempt_uuid(
    state: dict[str, str],
    state_file: Path,
    key: str,
    fingerprint: str,
) -> str:
    """Return a crash-safe attempt UUID, persisting it before any upload."""
    raw = state.get(key)
    if raw is not None:
        try:
            pending = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("checkpoint contains an invalid pending upload") from exc
        if not isinstance(pending, dict) or set(pending) != {"attemptId", "fingerprint"}:
            raise RuntimeError("checkpoint contains an invalid pending upload")
        attempt_id = pending.get("attemptId")
        pending_fingerprint = pending.get("fingerprint")
        if not isinstance(attempt_id, str) or not isinstance(pending_fingerprint, str):
            raise RuntimeError("checkpoint contains an invalid pending upload")
        try:
            parsed = uuid.UUID(attempt_id)
        except (ValueError, AttributeError) as exc:
            raise RuntimeError("checkpoint contains an invalid pending upload") from exc
        if parsed.version != 4 or str(parsed) != attempt_id:
            raise RuntimeError("checkpoint contains an invalid pending upload")
        if pending_fingerprint == fingerprint:
            return attempt_id

    attempt_id = str(uuid.uuid4())
    state[key] = json.dumps(
        {"attemptId": attempt_id, "fingerprint": fingerprint},
        sort_keys=True,
        separators=(",", ":"),
    )
    save_state(state_file, state)
    return attempt_id


def _canonical_row_key(row: Mapping[str, Any]) -> str:
    """Make retry payload bytes stable even if the source changes row order."""
    return json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _namespace_identities(
    rows: list[dict[str, str]], entity: str, source: str, source_instance_hash: str
) -> None:
    """Bind IDs to the reviewed source descriptor, stable across agent re-enrolment."""
    if len(source_instance_hash) != 64:
        raise RuntimeError("source descriptor fingerprint is invalid")
    field = "sku" if entity == "products" else "code"
    local_prefix = f"{source}:"
    server_prefix = f"{local_prefix}{source_instance_hash[:32]}:"
    for row in rows:
        value = row.get(field, "")
        if not value.startswith(local_prefix) or len(value) == len(local_prefix):
            raise RuntimeError(f"mapped {entity} row has an invalid {source} identity prefix")
        row[field] = server_prefix + value[len(local_prefix):]


def _mask(row: Mapping[str, str]) -> dict[str, str]:
    # Preview output is commonly copied into support chats. Mask every value,
    # including names, dates, identifiers and commercial data; --show-values is
    # the one explicit escape hatch for an on-site operator.
    return {
        field: f"[present; length={len(str(value))}]" if str(value) else "[empty]"
        for field, value in row.items()
    }
