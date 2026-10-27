"""Helpers for asserting on recorded spans in tests."""

from __future__ import annotations

import threading
from typing import Any

from tracewright._exporter import Exporter
from tracewright._span import Span


class InMemoryExporter(Exporter):
    """Collects finished spans in wire format instead of sending them."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._spans: list[dict[str, Any]] = []

    def export(self, span: Span) -> None:
        record = span.to_dict()
        with self._lock:
            self._spans.append(record)

    @property
    def spans(self) -> list[dict[str, Any]]:
        """Finished spans in the order they ended (children before parents)."""
        with self._lock:
            return list(self._spans)

    def clear(self) -> None:
        with self._lock:
            self._spans.clear()

    def by_name(self, name: str) -> list[dict[str, Any]]:
        return [s for s in self.spans if s["name"] == name]

    def children_of(self, span_id: str) -> list[dict[str, Any]]:
        """Direct children of ``span_id``, ordered by start time."""
        children = [s for s in self.spans if s["parent_span_id"] == span_id]
        return sorted(children, key=lambda s: s["start_time"])

    def roots(self) -> list[dict[str, Any]]:
        return [s for s in self.spans if s["parent_span_id"] is None]
