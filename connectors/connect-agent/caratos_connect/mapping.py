"""Pure source-row to canonical-field mapping and local preview checks."""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence, Tuple


def _text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except (TypeError, ValueError):
            pass
    return str(value).strip()


def _lookup(row: Mapping[str, Any], candidates: Sequence[str]) -> str:
    lowered = {str(key).lower(): value for key, value in row.items()}
    for candidate in candidates:
        value = lowered.get(candidate.lower())
        if value is not None and _text(value):
            return _text(value)
    return ""


def map_rows(
    definition: Mapping[str, Any], raw_rows: Iterable[Mapping[str, Any]]
) -> Tuple[list[dict[str, str]], list[dict[str, Any]]]:
    rows, issues, _filtered = map_rows_detailed(definition, raw_rows)
    return rows, issues


def map_rows_detailed(
    definition: Mapping[str, Any], raw_rows: Iterable[Mapping[str, Any]]
) -> Tuple[list[dict[str, str]], list[dict[str, Any]], int]:
    """Map rows and account separately for deliberately filtered source rows."""
    fields: Mapping[str, Sequence[str]] = definition["fields"]
    prefixes: Mapping[str, str] = definition.get("prefixValues", {})
    required = set(definition.get("required", []))
    # Connect profiles always carry stable source identity plus a readable name.
    # `required` remains available for extra client-specific requirements.
    required.update(field for field in ("code", "sku", "name") if field in fields)
    include = definition.get("include", [])
    output: list[dict[str, str]] = []
    issues: list[dict[str, Any]] = []
    filtered = 0

    for index, raw in enumerate(raw_rows, start=1):
        mapped = {field: _lookup(raw, candidates) for field, candidates in fields.items()}
        if any(not _matches(mapped, rule) for rule in include):
            filtered += 1
            continue
        for field, prefix in prefixes.items():
            if mapped.get(field):
                mapped[field] = f"{prefix}{mapped[field]}"
        missing = sorted(field for field in required if not mapped.get(field))
        if missing:
            issues.append({"row": index, "code": "missing_required", "fields": missing})
            continue
        output.append({key: value for key, value in mapped.items() if not key.startswith("_")})
    return output, issues, filtered


def _matches(mapped: Mapping[str, str], rule: Mapping[str, Any]) -> bool:
    field = str(rule.get("field", ""))
    value = mapped.get(field, "").casefold()
    contains = rule.get("containsAny")
    if isinstance(contains, list):
        return any(str(item).casefold() in value for item in contains)
    equals = rule.get("equalsAny")
    if isinstance(equals, list):
        return value in {str(item).casefold() for item in equals}
    return True
