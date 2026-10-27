from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

import tracewright
from tracewright._serialize import MAX_PAYLOAD_BYTES, dumps, to_jsonable, truncate_payload
from tracewright.testing import InMemoryExporter


class Color(Enum):
    RED = "red"


@dataclass
class Point:
    x: int
    y: int


def test_to_jsonable_handles_common_types() -> None:
    value = {
        "tuple": (1, 2),
        "set": {3},
        "enum": Color.RED,
        "dataclass": Point(1, 2),
        "when": datetime(2026, 1, 2, tzinfo=timezone.utc),
        "bytes": b"\x00\x01",
        1: "int key",
    }
    assert to_jsonable(value) == {
        "tuple": [1, 2],
        "set": [3],
        "enum": "red",
        "dataclass": {"x": 1, "y": 2},
        "when": "2026-01-02T00:00:00+00:00",
        "bytes": "<2 bytes>",
        "1": "int key",
    }


def test_non_finite_floats_become_strings() -> None:
    result = to_jsonable([math.nan, math.inf, 1.5])
    assert result == ["nan", "inf", 1.5]
    dumps(result)  # would raise ValueError with allow_nan=False if left as floats


def test_cycles_and_broken_repr_never_raise() -> None:
    cyclic: list[object] = []
    cyclic.append(cyclic)

    class BrokenRepr:
        def __repr__(self) -> str:
            raise RuntimeError

    json.loads(dumps(to_jsonable(cyclic)))
    assert to_jsonable(BrokenRepr()) == "<unrepresentable BrokenRepr>"


def test_truncate_leaves_small_payloads_alone() -> None:
    assert truncate_payload({"a": 1}) == ({"a": 1}, False)
    assert truncate_payload(None) == (None, False)


def test_truncate_caps_size_without_splitting_utf8() -> None:
    payload = "é" * MAX_PAYLOAD_BYTES  # two bytes per char
    truncated, was_truncated = truncate_payload(payload)

    assert was_truncated
    assert isinstance(truncated, str)
    assert len(truncated.encode("utf-8")) <= MAX_PAYLOAD_BYTES
    assert truncated.endswith("[truncated by tracewright]")


def test_oversized_span_payload_is_flagged(exporter: InMemoryExporter) -> None:
    with tracewright.span("big", input="x" * (MAX_PAYLOAD_BYTES + 1)) as span:
        span.set_output("small")

    (record,) = exporter.spans
    assert record["attributes"]["tracewright.truncated"] is True
    assert len(record["input"].encode()) <= MAX_PAYLOAD_BYTES
    assert record["output"] == "small"
