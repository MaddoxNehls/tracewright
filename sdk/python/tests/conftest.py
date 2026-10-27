from __future__ import annotations

from collections.abc import Iterator

import pytest

import tracewright
from tracewright.testing import InMemoryExporter


@pytest.fixture
def exporter() -> Iterator[InMemoryExporter]:
    memory = InMemoryExporter()
    tracewright.init(exporter=memory)
    yield memory
    tracewright.shutdown()


@pytest.fixture(autouse=True)
def _no_env_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRACEWRIGHT_API_KEY", raising=False)
    monkeypatch.delenv("TRACEWRIGHT_ENDPOINT", raising=False)
