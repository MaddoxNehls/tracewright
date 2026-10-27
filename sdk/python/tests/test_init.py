from __future__ import annotations

import pytest

import tracewright
from tracewright import HttpExporter, NoopExporter
from tracewright._tracer import _exporter as initial_exporter


def active_exporter() -> tracewright.Exporter:
    from tracewright import _tracer

    return _tracer._exporter


def test_sdk_is_noop_before_init() -> None:
    assert isinstance(initial_exporter, NoopExporter)


def test_init_without_api_key_is_a_silent_noop() -> None:
    tracewright.init()
    try:
        assert isinstance(active_exporter(), NoopExporter)

        @tracewright.trace(kind="tool")
        def tool(x: int) -> int:
            return x * 2

        with tracewright.run("run", tags=["t"]) as run:
            assert tool(2) == 4
            run.set_output("done")
        assert tracewright.flush(timeout=0.1)
        assert tracewright.stats() == tracewright.ExporterStats()
    finally:
        tracewright.shutdown()


def test_init_reads_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRACEWRIGHT_API_KEY", "tw_" + "1" * 32)
    monkeypatch.setenv("TRACEWRIGHT_ENDPOINT", "http://collector.test:9999")
    tracewright.init()
    try:
        exporter = active_exporter()
        assert isinstance(exporter, HttpExporter)
        assert exporter._url == "http://collector.test:9999/v1/spans"
    finally:
        tracewright.shutdown()
    assert isinstance(active_exporter(), NoopExporter)


def test_unreachable_endpoint_never_raises_into_host() -> None:
    tracewright.init(api_key="tw_" + "2" * 32, endpoint="http://127.0.0.1:9")
    try:
        with tracewright.run("run"):
            pass
        tracewright.flush(timeout=0.2)
    finally:
        tracewright.shutdown(timeout=0.2)
