"""Conversion of arbitrary Python values into JSON-safe snapshots, plus payload truncation."""

from __future__ import annotations

import dataclasses
import datetime as dt
import enum
import json
import math
from collections.abc import Mapping
from typing import Any

MAX_PAYLOAD_BYTES = 256 * 1024
_MAX_DEPTH = 32
_TRUNCATION_MARKER = "...[truncated by tracewright]"


def to_jsonable(value: Any, _depth: int = 0) -> Any:
    """Return a deep, JSON-serializable copy of ``value``.

    Unknown objects fall back to ``repr()``, so this never raises. Because the result is a
    copy, later mutation of the original (e.g. an agent appending to its message list)
    does not change what was recorded.
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if _depth >= _MAX_DEPTH:
        return _safe_repr(value)

    depth = _depth + 1
    if isinstance(value, Mapping):
        return {str(k): to_jsonable(v, depth) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(v, depth) for v in value]
    if isinstance(value, enum.Enum):
        return to_jsonable(value.value, depth)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"

    model_dump = getattr(value, "model_dump", None)  # pydantic v2, used by anthropic/openai
    if callable(model_dump):
        try:
            return to_jsonable(model_dump(mode="json"), depth)
        except Exception:
            return _safe_repr(value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            f.name: to_jsonable(getattr(value, f.name, None), depth)
            for f in dataclasses.fields(value)
        }
    return _safe_repr(value)


def dumps(value: Any) -> str:
    """Compact JSON encoding for values already produced by :func:`to_jsonable`."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def truncate_payload(value: Any, limit: int = MAX_PAYLOAD_BYTES) -> tuple[Any, bool]:
    """Cap the serialized size of a JSON-safe payload.

    Oversized payloads become a string holding a prefix of their JSON encoding, so the
    recorded span stays readable. Returns ``(payload, was_truncated)``.
    """
    if value is None:
        return None, False
    encoded = dumps(value).encode("utf-8")
    if len(encoded) <= limit:
        return value, False
    budget = max(limit - len(_TRUNCATION_MARKER.encode("utf-8")), 0)
    head = encoded[:budget].decode("utf-8", errors="ignore")
    return head + _TRUNCATION_MARKER, True


def _safe_repr(value: object) -> str:
    try:
        return repr(value)
    except Exception:
        return f"<unrepresentable {type(value).__name__}>"
