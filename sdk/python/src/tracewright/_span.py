"""The span model: one timed step of an agent run, serialized per docs/contract.md."""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any, Literal

from tracewright._serialize import to_jsonable, truncate_payload

SpanKind = Literal["agent", "llm", "tool", "custom"]
SpanStatus = Literal["ok", "error"]

MAX_NAME_LENGTH = 256

# Anchor the wall clock once, then derive timestamps from the monotonic high-resolution
# counter. This keeps sibling spans correctly ordered even where time.time_ns() is coarse
# (about 15 ms on Windows before Python 3.13).
_WALL_CLOCK_ANCHOR_NS = time.time_ns() - time.perf_counter_ns()


def now_ns() -> int:
    """Nanoseconds since the Unix epoch, monotonic within this process."""
    return _WALL_CLOCK_ANCHOR_NS + time.perf_counter_ns()


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


def format_timestamp(unix_ns: int) -> str:
    """Format nanoseconds since the epoch as an RFC3339Nano UTC timestamp."""
    seconds, nanos = divmod(unix_ns, 1_000_000_000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(seconds)) + f".{nanos:09d}Z"


class Span:
    """A single recorded operation.

    Spans are created through :func:`tracewright.run`, :func:`tracewright.span` or the
    :func:`tracewright.trace` decorator rather than instantiated directly. Values passed to
    the setters are snapshotted immediately, so mutating them afterwards has no effect.
    """

    __slots__ = (
        "_attributes",
        "_end_ns",
        "_ended",
        "_error",
        "_input",
        "_lock",
        "_on_end",
        "_output",
        "_start_ns",
        "_status",
        "kind",
        "name",
        "parent",
        "parent_span_id",
        "span_id",
        "trace_id",
    )

    def __init__(
        self,
        name: str,
        kind: SpanKind,
        *,
        trace_id: str,
        parent_span_id: str | None,
        on_end: Callable[[Span], None],
        parent: Span | None = None,
    ) -> None:
        self.name = (name or "span")[:MAX_NAME_LENGTH]
        self.kind: SpanKind = kind
        self.trace_id = trace_id
        self.span_id = new_span_id()
        self.parent_span_id = parent_span_id
        # The live parent, so replay can find the enclosing step without a registry.
        self.parent = parent
        self._on_end = on_end
        self._lock = threading.Lock()
        self._attributes: dict[str, Any] = {}
        self._input: Any = None
        self._output: Any = None
        self._status: SpanStatus = "ok"
        self._error: dict[str, str] | None = None
        self._ended = False
        self._start_ns = now_ns()
        self._end_ns: int | None = None

    @property
    def status(self) -> SpanStatus:
        return self._status

    @property
    def ended(self) -> bool:
        return self._ended

    @property
    def attributes(self) -> Mapping[str, Any]:
        return dict(self._attributes)

    def set_attribute(self, key: str, value: Any) -> None:
        if not self._ended:
            self._attributes[key] = to_jsonable(value)

    def set_attributes(self, attributes: Mapping[str, Any]) -> None:
        for key, value in attributes.items():
            self.set_attribute(key, value)

    def set_input(self, value: Any) -> None:
        if not self._ended:
            self._input = to_jsonable(value)

    def set_output(self, value: Any) -> None:
        if not self._ended:
            self._output = to_jsonable(value)

    def record_exception(self, exc: BaseException) -> None:
        self.set_error(type(exc).__name__, str(exc))

    def set_error(self, error_type: str, message: str) -> None:
        if not self._ended:
            self._status = "error"
            self._error = {"type": error_type, "message": message}

    def end(self) -> None:
        """Finish the span and hand it to the exporter. Subsequent calls are no-ops."""
        with self._lock:
            if self._ended:
                return
            self._ended = True
        self._end_ns = now_ns()
        self._on_end(self)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to the wire format, truncating oversized input/output."""
        end_ns = self._end_ns if self._end_ns is not None else now_ns()
        attributes = dict(self._attributes)
        payload_input, input_truncated = truncate_payload(self._input)
        payload_output, output_truncated = truncate_payload(self._output)
        if input_truncated or output_truncated:
            attributes["tracewright.truncated"] = True
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "name": self.name,
            "kind": self.kind,
            "start_time": format_timestamp(self._start_ns),
            "end_time": format_timestamp(end_ns),
            "status": self._status,
            "error": self._error,
            "attributes": attributes,
            "input": payload_input,
            "output": payload_output,
        }

    def __repr__(self) -> str:
        return f"Span(name={self.name!r}, kind={self.kind!r}, span_id={self.span_id!r})"
