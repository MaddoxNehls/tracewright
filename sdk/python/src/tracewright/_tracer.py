"""Global tracer state, span context managers, and the ``@trace`` decorator."""

from __future__ import annotations

import atexit
import contextvars
import functools
import inspect
import logging
import os
import threading
from collections.abc import Awaitable, Callable, Iterable, Mapping
from types import TracebackType
from typing import Any, ParamSpec, TypeVar, cast, overload

from tracewright._exporter import (
    DEFAULT_ENDPOINT,
    Exporter,
    ExporterStats,
    HttpExporter,
    NoopExporter,
)
from tracewright._span import Span, SpanKind, new_trace_id

logger = logging.getLogger("tracewright")

P = ParamSpec("P")
R = TypeVar("R")

_current_span: contextvars.ContextVar[Span | None] = contextvars.ContextVar(
    "tracewright_current_span", default=None
)
_exporter: Exporter = NoopExporter()
_state_lock = threading.Lock()
_atexit_registered = False
_ATEXIT_FLUSH_TIMEOUT = 2.0


def init(
    api_key: str | None = None,
    endpoint: str | None = None,
    *,
    exporter: Exporter | None = None,
    batch_size: int = 100,
    flush_interval: float = 1.0,
    max_queue_size: int = 2048,
) -> None:
    """Configure the SDK.

    ``api_key`` and ``endpoint`` default to ``TRACEWRIGHT_API_KEY`` and
    ``TRACEWRIGHT_ENDPOINT``. Without an API key (and no explicit ``exporter``) the SDK
    stays a silent no-op: spans are still created so instrumented code runs unchanged,
    but nothing is sent. Calling ``init`` again replaces the previous exporter.
    """
    global _exporter, _atexit_registered
    if exporter is None:
        api_key = api_key or os.environ.get("TRACEWRIGHT_API_KEY")
        endpoint = endpoint or os.environ.get("TRACEWRIGHT_ENDPOINT") or DEFAULT_ENDPOINT
        if api_key:
            exporter = HttpExporter(
                api_key,
                endpoint,
                batch_size=batch_size,
                flush_interval=flush_interval,
                max_queue_size=max_queue_size,
            )
        else:
            exporter = NoopExporter()

    with _state_lock:
        previous, _exporter = _exporter, exporter
        if not _atexit_registered:
            atexit.register(shutdown, _ATEXIT_FLUSH_TIMEOUT)
            _atexit_registered = True
    _safe_shutdown(previous, timeout=_ATEXIT_FLUSH_TIMEOUT)


def flush(timeout: float | None = 5.0) -> bool:
    """Wait for queued spans to be delivered. Returns False on timeout."""
    try:
        return _exporter.flush(timeout)
    except Exception:
        logger.debug("tracewright: flush failed", exc_info=True)
        return False


def shutdown(timeout: float | None = 5.0) -> None:
    """Flush and stop the exporter, reverting to no-op mode."""
    global _exporter
    with _state_lock:
        previous, _exporter = _exporter, NoopExporter()
    _safe_shutdown(previous, timeout)


def stats() -> ExporterStats:
    """Counters from the active exporter (exported, dropped, failed)."""
    return _exporter.stats


def get_current_span() -> Span | None:
    return _current_span.get()


def _safe_shutdown(exporter: Exporter, timeout: float | None) -> None:
    try:
        exporter.shutdown(timeout)
    except Exception:
        logger.debug("tracewright: exporter shutdown failed", exc_info=True)


def _export(span: Span) -> None:
    try:
        _exporter.export(span)
    except Exception:
        logger.debug("tracewright: export failed", exc_info=True)


class SpanContext:
    """Context manager (sync or async) that opens a span and makes it current."""

    def __init__(
        self,
        name: str,
        kind: SpanKind,
        *,
        input: Any = None,
        attributes: Mapping[str, Any] | None = None,
        new_trace: bool = False,
    ) -> None:
        self._name = name
        self._kind: SpanKind = kind
        self._input = input
        self._attributes = attributes
        self._new_trace = new_trace
        self._span: Span | None = None
        self._token: contextvars.Token[Span | None] | None = None

    def __enter__(self) -> Span:
        parent = None if self._new_trace else _current_span.get()
        span = Span(
            self._name,
            self._kind,
            trace_id=parent.trace_id if parent else new_trace_id(),
            parent_span_id=parent.span_id if parent else None,
            on_end=_export,
        )
        if self._input is not None:
            span.set_input(self._input)
        if self._attributes:
            span.set_attributes(self._attributes)
        self._span = span
        self._token = _current_span.set(span)
        return span

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        span, token = self._span, self._token
        if span is None or token is None:
            return
        if exc is not None:
            span.record_exception(exc)
        _current_span.reset(token)
        span.end()

    async def __aenter__(self) -> Span:
        return self.__enter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.__exit__(exc_type, exc, tb)


def run(
    name: str,
    *,
    tags: Iterable[str] | None = None,
    input: Any = None,
    attributes: Mapping[str, Any] | None = None,
) -> SpanContext:
    """Start a new run: a root ``agent`` span with a fresh trace id.

    Usable as ``with tracewright.run(...) as run:`` or ``async with``.
    """
    attrs = dict(attributes or {})
    if tags is not None:
        attrs["tracewright.tags"] = [str(tag) for tag in tags]
    return SpanContext(name, "agent", input=input, attributes=attrs, new_trace=True)


def span(
    name: str,
    *,
    kind: SpanKind = "custom",
    input: Any = None,
    attributes: Mapping[str, Any] | None = None,
) -> SpanContext:
    """Open a child of the current span (or a new trace if there is none)."""
    return SpanContext(name, kind, input=input, attributes=attributes)


@overload
def trace(func: Callable[P, R], /) -> Callable[P, R]: ...


@overload
def trace(
    *,
    kind: SpanKind = ...,
    name: str | None = ...,
    capture_input: bool = ...,
    capture_output: bool = ...,
) -> Callable[[Callable[P, R]], Callable[P, R]]: ...


def trace(
    func: Callable[P, R] | None = None,
    /,
    *,
    kind: SpanKind = "custom",
    name: str | None = None,
    capture_input: bool = True,
    capture_output: bool = True,
) -> Callable[P, R] | Callable[[Callable[P, R]], Callable[P, R]]:
    """Record each call of a sync or async function as a span.

    Bound arguments become the span input and the return value its output. Exceptions
    mark the span as errored and propagate unchanged. Works bare (``@trace``) or with
    options (``@trace(kind="tool")``). Generator functions are not supported.
    """

    def decorate(fn: Callable[P, R]) -> Callable[P, R]:
        span_name = name or str(getattr(fn, "__name__", "function"))
        signature = _signature_or_none(fn)
        attributes = {"gen_ai.tool.name": span_name} if kind == "tool" else None

        def open_span(args: tuple[Any, ...], kwargs: dict[str, Any]) -> SpanContext:
            call_input = _bind_arguments(signature, args, kwargs) if capture_input else None
            return SpanContext(span_name, kind, input=call_input, attributes=attributes)

        if inspect.iscoroutinefunction(fn):
            async_fn = cast(Callable[..., Awaitable[Any]], fn)

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                with open_span(args, kwargs) as current:
                    result = await async_fn(*args, **kwargs)
                    if capture_output:
                        current.set_output(result)
                    return result

            return cast(Callable[P, R], async_wrapper)

        @functools.wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with open_span(args, kwargs) as current:
                result = fn(*args, **kwargs)
                if capture_output:
                    current.set_output(result)
                return result

        return wrapper

    if func is not None:
        return decorate(func)
    return decorate


def _signature_or_none(fn: Callable[..., Any]) -> inspect.Signature | None:
    try:
        return inspect.signature(fn)
    except (TypeError, ValueError):
        return None


def _bind_arguments(
    signature: inspect.Signature | None, args: tuple[Any, ...], kwargs: dict[str, Any]
) -> dict[str, Any]:
    if signature is not None:
        try:
            bound = signature.bind(*args, **kwargs)
        except TypeError:
            pass  # the call itself will raise; record the raw arguments
        else:
            bound.apply_defaults()
            return {k: v for k, v in bound.arguments.items() if k not in ("self", "cls")}
    return {"args": list(args), "kwargs": kwargs}
