"""Span exporters. The HTTP exporter ships batches from a background thread."""

from __future__ import annotations

import gzip
import logging
import queue
import random
import threading
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from tracewright._serialize import dumps
from tracewright._span import Span

logger = logging.getLogger("tracewright")

DEFAULT_ENDPOINT = "http://localhost:4318"
SPANS_PATH = "/v1/spans"
# Contract limit is 5 MB per request; stay well under it before compression.
MAX_BODY_BYTES = 4 * 1024 * 1024


@dataclass
class ExporterStats:
    exported: int = 0
    dropped_queue_full: int = 0
    failed: int = 0


class Exporter(ABC):
    """Receives finished spans. Implementations must never raise into the caller."""

    @abstractmethod
    def export(self, span: Span) -> None: ...

    def flush(self, timeout: float | None = None) -> bool:
        """Block until queued spans are delivered or ``timeout`` elapses. True on success."""
        return True

    def shutdown(self, timeout: float | None = None) -> None:
        self.flush(timeout)

    @property
    def stats(self) -> ExporterStats:
        return ExporterStats()


class NoopExporter(Exporter):
    def export(self, span: Span) -> None:
        pass


class HttpExporter(Exporter):
    """Batches spans to ``POST /v1/spans`` without ever blocking the host program.

    ``export`` is a non-blocking enqueue onto a bounded queue; when the queue is full the
    span is dropped and counted. A daemon worker drains the queue every ``flush_interval``
    seconds (or sooner once a full batch is waiting), gzips each batch, and retries network
    errors, 429 and 5xx responses with exponential backoff and full jitter, honouring
    ``Retry-After``. Other 4xx responses are not retryable and the batch is discarded.
    """

    def __init__(
        self,
        api_key: str,
        endpoint: str = DEFAULT_ENDPOINT,
        *,
        batch_size: int = 100,
        flush_interval: float = 1.0,
        max_queue_size: int = 2048,
        max_retries: int = 5,
        backoff_base: float = 0.5,
        backoff_max: float = 30.0,
        timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], object] | None = None,
    ) -> None:
        self._url = endpoint.rstrip("/") + SPANS_PATH
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
        }
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._max_retries = max_retries
        self._backoff_base = backoff_base
        self._backoff_max = backoff_max
        self._client = httpx.Client(timeout=timeout, transport=transport)

        self._queue: queue.Queue[Span] = queue.Queue(maxsize=max_queue_size)
        self._stats = ExporterStats()
        self._pending = 0  # enqueued but not yet exported or failed
        self._pending_cv = threading.Condition()
        self._flush_requested = False  # guarded by _pending_cv; consumed by the worker
        self._wakeup = threading.Event()
        self._closed = threading.Event()
        # Backoff waits on the closed event so shutdown interrupts it immediately.
        self._sleep = sleep or self._closed.wait
        self._worker = threading.Thread(target=self._run, name="tracewright-exporter", daemon=True)
        self._worker.start()

    @property
    def stats(self) -> ExporterStats:
        with self._pending_cv:
            return ExporterStats(**vars(self._stats))

    def export(self, span: Span) -> None:
        if self._closed.is_set():
            return
        with self._pending_cv:
            try:
                self._queue.put_nowait(span)
            except queue.Full:
                self._stats.dropped_queue_full += 1
                return
            self._pending += 1
        if self._queue.qsize() >= self._batch_size:
            self._wakeup.set()

    def flush(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._pending_cv:
            self._request_flush()
            while self._pending > 0 and self._worker.is_alive():
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._pending_cv.wait(remaining)
                # Spans exported while we waited may have been followed by new ones.
                self._request_flush()
            return self._pending == 0

    def _request_flush(self) -> None:
        # Caller holds _pending_cv. The flag is set before the wakeup, and the worker
        # reads and clears it under the same lock, so a request can't be lost.
        self._flush_requested = True
        self._wakeup.set()

    def shutdown(self, timeout: float | None = None) -> None:
        self.flush(timeout)
        self._closed.set()
        self._wakeup.set()
        self._worker.join(timeout=0.5)
        self._client.close()

    def _run(self) -> None:
        while not self._closed.is_set():
            timed_out = not self._wakeup.wait(self._flush_interval)
            self._wakeup.clear()
            with self._pending_cv:
                force = timed_out or self._flush_requested or self._closed.is_set()
                self._flush_requested = False
            try:
                self._drain(force)
            except Exception:  # the worker must survive anything
                logger.exception("tracewright exporter loop failed")

    def _drain(self, force: bool) -> None:
        # A size-triggered wakeup ships only full batches, so spans still being
        # emitted aren't split into small requests; the interval tick and flush()
        # ship whatever is left.
        while force or self._queue.qsize() >= self._batch_size:
            batch: list[Span] = []
            while len(batch) < self._batch_size:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            if not batch:
                return
            try:
                self._export_batch(batch)
            finally:
                self._complete(len(batch))

    def _export_batch(self, batch: list[Span]) -> None:
        chunk: list[bytes] = []
        chunk_bytes = 0
        for span in batch:
            try:
                encoded = dumps(span.to_dict()).encode("utf-8")
            except Exception:
                logger.warning("tracewright: dropping unserializable span %r", span, exc_info=True)
                self._count_failed(1)
                continue
            if chunk and chunk_bytes + len(encoded) > MAX_BODY_BYTES:
                self._send(chunk)
                chunk, chunk_bytes = [], 0
            chunk.append(encoded)
            chunk_bytes += len(encoded) + 1
        if chunk:
            self._send(chunk)

    def _send(self, encoded_spans: list[bytes]) -> None:
        body = gzip.compress(b'{"spans":[' + b",".join(encoded_spans) + b"]}")
        count = len(encoded_spans)
        for attempt in range(self._max_retries + 1):
            delay: float
            try:
                response = self._client.post(self._url, content=body, headers=self._headers)
            except httpx.HTTPError as exc:
                logger.debug("tracewright: export attempt %d failed: %s", attempt + 1, exc)
                delay = self._backoff(attempt)
            except Exception:
                logger.warning("tracewright: unexpected export error", exc_info=True)
                break
            else:
                if response.is_success:
                    with self._pending_cv:
                        self._stats.exported += count
                    return
                if not _is_retryable(response.status_code):
                    logger.warning(
                        "tracewright: ingest rejected %d spans with HTTP %d: %s",
                        count,
                        response.status_code,
                        response.text[:500],
                    )
                    self._count_failed(count)
                    return
                delay = _retry_after(response, self._backoff_max) or self._backoff(attempt)
            if attempt == self._max_retries or self._closed.is_set():
                break
            self._sleep(delay)
        logger.warning("tracewright: dropping %d spans after %d attempts", count, attempt + 1)
        self._count_failed(count)

    def _backoff(self, attempt: int) -> float:
        return random.uniform(0, min(self._backoff_max, self._backoff_base * 2**attempt))

    def _count_failed(self, count: int) -> None:
        with self._pending_cv:
            self._stats.failed += count

    def _complete(self, count: int) -> None:
        with self._pending_cv:
            self._pending -= count
            self._pending_cv.notify_all()


def _is_retryable(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def _retry_after(response: httpx.Response, cap: float) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None  # HTTP-date form is not used by the ingest service
    return min(max(seconds, 0.0), cap)
