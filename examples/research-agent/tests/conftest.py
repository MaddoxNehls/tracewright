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
