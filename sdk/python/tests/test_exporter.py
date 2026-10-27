from __future__ import annotations

import gzip
import json
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest

from tracewright import HttpExporter, Span

Handler = Callable[[httpx.Request], httpx.Response]


class Recorder:
    """A MockTransport handler that records decoded requests and replays scripted statuses."""

    def __init__(self, *responses: httpx.Response) -> None:
        self._responses = list(responses)
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.bodies.append(json.loads(gzip.decompress(request.content)))
        if self._responses:
            return self._responses.pop(0)
        return httpx.Response(202, json={"accepted": len(self.bodies[-1]["spans"])})

    @property
    def span_counts(self) -> list[int]:
        return [len(body["spans"]) for body in self.bodies]


@pytest.fixture
def make_exporter() -> Iterator[Callable[..., HttpExporter]]:
    created: list[HttpExporter] = []

    def factory(handler: Handler, **kwargs: Any) -> HttpExporter:
        options: dict[str, Any] = {"backoff_base": 0.001, "flush_interval": 60.0}
        options.update(kwargs)
        exporter = HttpExporter(
            "tw_" + "0" * 32,
            "http://ingest.test/",
            transport=httpx.MockTransport(handler),
            **options,
        )
        created.append(exporter)
        return exporter

    yield factory
    for exporter in created:
        exporter.shutdown(timeout=1)


def emit(exporter: HttpExporter, count: int) -> None:
    for i in range(count):
        Span(
            f"s{i}", "custom", trace_id="a" * 32, parent_span_id=None, on_end=exporter.export
        ).end()


def test_flush_sends_gzipped_authenticated_batch(
    make_exporter: Callable[..., HttpExporter],
) -> None:
    recorder = Recorder()
    exporter = make_exporter(recorder)

    emit(exporter, 3)
    assert exporter.flush(timeout=5)

    (request,) = recorder.requests
    assert request.url == "http://ingest.test/v1/spans"
    assert request.headers["Authorization"] == "Bearer tw_" + "0" * 32
    assert request.headers["Content-Encoding"] == "gzip"
    assert [s["name"] for s in recorder.bodies[0]["spans"]] == ["s0", "s1", "s2"]
    assert exporter.stats.exported == 3


def test_spans_are_batched_by_batch_size(make_exporter: Callable[..., HttpExporter]) -> None:
    recorder = Recorder()
    exporter = make_exporter(recorder, batch_size=100, max_queue_size=1000)

    emit(exporter, 250)
    assert exporter.flush(timeout=5)

    assert recorder.span_counts == [100, 100, 50]


def test_full_batch_is_sent_without_waiting_for_interval(
    make_exporter: Callable[..., HttpExporter],
) -> None:
    sent = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        sent.set()
        return httpx.Response(202)

    exporter = make_exporter(handler, batch_size=5, flush_interval=60.0)
    emit(exporter, 5)

    assert sent.wait(timeout=5)


@pytest.mark.parametrize("status", [429, 500, 503])
def test_retryable_statuses_are_retried(
    make_exporter: Callable[..., HttpExporter], status: int
) -> None:
    recorder = Recorder(httpx.Response(status), httpx.Response(status))
    exporter = make_exporter(recorder)

    emit(exporter, 2)
    assert exporter.flush(timeout=5)

    assert len(recorder.requests) == 3
    assert exporter.stats.exported == 2
    assert exporter.stats.failed == 0


def test_retry_after_header_is_honoured(make_exporter: Callable[..., HttpExporter]) -> None:
    delays: list[float] = []
    recorder = Recorder(httpx.Response(429, headers={"Retry-After": "7"}))
    exporter = make_exporter(recorder, sleep=delays.append)

    emit(exporter, 1)
    assert exporter.flush(timeout=5)

    assert delays == [7.0]


def test_network_errors_are_retried_with_backoff(
    make_exporter: Callable[..., HttpExporter],
) -> None:
    delays: list[float] = []
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(202)

    exporter = make_exporter(handler, sleep=delays.append, backoff_base=1.0)
    emit(exporter, 1)
    assert exporter.flush(timeout=5)

    assert attempts == 3
    assert len(delays) == 2
    assert 0 <= delays[0] <= 1.0
    assert 0 <= delays[1] <= 2.0


def test_gives_up_after_max_retries(make_exporter: Callable[..., HttpExporter]) -> None:
    recorder = Recorder(*[httpx.Response(503)] * 10)
    exporter = make_exporter(recorder, max_retries=2, sleep=lambda _: None)

    emit(exporter, 4)
    assert exporter.flush(timeout=5)

    assert len(recorder.requests) == 3
    assert exporter.stats.failed == 4


def test_client_errors_are_not_retried(make_exporter: Callable[..., HttpExporter]) -> None:
    recorder = Recorder(httpx.Response(400, json={"error": "invalid", "details": []}))
    exporter = make_exporter(recorder)

    emit(exporter, 1)
    assert exporter.flush(timeout=5)

    assert len(recorder.requests) == 1
    assert exporter.stats.failed == 1


def test_drops_with_counter_when_queue_is_full(
    make_exporter: Callable[..., HttpExporter],
) -> None:
    recorder = Recorder()
    exporter = make_exporter(recorder, max_queue_size=3, batch_size=100, flush_interval=60.0)

    emit(exporter, 10)

    assert exporter.stats.dropped_queue_full == 7
    assert exporter.flush(timeout=5)
    assert recorder.span_counts == [3]


def test_unexpected_transport_failure_never_raises(
    make_exporter: Callable[..., HttpExporter],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("transport exploded")

    exporter = make_exporter(handler)
    emit(exporter, 2)

    assert exporter.flush(timeout=5)
    assert exporter.stats.failed == 2
    emit(exporter, 1)  # the worker is still alive
    assert exporter.flush(timeout=5)
    assert exporter.stats.failed == 3


def test_flush_times_out_instead_of_blocking(make_exporter: Callable[..., HttpExporter]) -> None:
    release = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        release.wait(timeout=5)
        return httpx.Response(202)

    exporter = make_exporter(handler)
    emit(exporter, 1)

    assert exporter.flush(timeout=0.05) is False
    release.set()
    assert exporter.flush(timeout=5)


def test_export_after_shutdown_is_ignored(make_exporter: Callable[..., HttpExporter]) -> None:
    recorder = Recorder()
    exporter = make_exporter(recorder)
    exporter.shutdown(timeout=1)

    emit(exporter, 1)

    assert recorder.requests == []


def test_shutdown_interrupts_retry_backoff(make_exporter: Callable[..., HttpExporter]) -> None:
    first_attempt = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        first_attempt.set()
        return httpx.Response(503)

    exporter = make_exporter(handler, backoff_base=30.0, backoff_max=30.0, sleep=None)
    emit(exporter, 1)
    exporter.flush(timeout=0)  # wake the worker
    assert first_attempt.wait(timeout=5)

    started = time.monotonic()
    exporter.shutdown(timeout=0.1)

    assert time.monotonic() - started < 2
    assert exporter.stats.failed == 1
