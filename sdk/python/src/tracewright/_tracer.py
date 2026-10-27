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
from typing import TYPE_CHECKING, Any, ParamSpec, TypeVar, cast, overload

from tracewright._exporter import (
    DEFAULT_ENDPOINT,
    Exporter,
    ExporterStats,
    HttpExporter,
    NoopExporter,
)
from tracewright._replay_state import active_replay
from tracewright._serialize import to_jsonable
from tracewright._span import Span, SpanKind, new_trace_id

if TYPE_CHECKING:
    from tracewright._replay import RecordedCall

logger = logging.getLogger("tracewright")

P = ParamSpec("P")
R = TypeVar("R")

_current_span: contextvars.ContextVar[Span | None] = contextvars.ContextVar(
    "tracewright_current_span", default=None
)
_exporter: Exporter = NoopExporter()
_api_key: str | None = None
_endpoint: str = DEFAULT_ENDPOINT
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
    global _exporter, _atexit_registered, _api_key, _endpoint
    api_key = api_key or os.environ.get("TRACEWRIGHT_API_KEY")
    endpoint = endpoint or os.environ.get("TRACEWRIGHT_ENDPOINT") or DEFAULT_ENDPOINT
    if exporter is None:
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
        _api_key, _endpoint = api_key, endpoint
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


def configured_credentials() -> tuple[str | None, str]:
    """The API key and endpoint from the last :func:`init` (or the environment)."""
    return _api_key or os.environ.get("TRACEWRIGHT_API_KEY"), _endpoint


def _safe_shutdown(exporter: Exporter, timeout: float | None) -> None:
    try:
        exporter.shutdown(timeout)
    except Exception:
        logger.debug("tracewright: exporter shutdown failed", exc_info=True)


def _export(span: Span) -> None:
    if _captures:
        with _state_lock:
            captured = _captures.get(span.trace_id)
            if captured is not None:
                captured.append(span)
    try:
        _exporter.export(span)
    except Exception:
        logger.debug("tracewright: export failed", exc_info=True)


# Finished spans of selected traces, kept locally whatever the exporter does. Keyed by
# trace id rather than context so spans ended on worker threads are still caught.
_captures: dict[str, list[Span]] = {}


class TraceCapture:
    """Collects every span of one trace as it ends; used by ``tracewright eval``."""

    def __init__(self, trace_id: str) -> None:
        self.trace_id = trace_id
        with _state_lock:
            self._spans = _captures.setdefault(trace_id, [])

    def stop(self) -> list[Span]:
        """Stop collecting and return the spans that ended so far."""
        with _state_lock:
            _captures.pop(self.trace_id, None)
            return list(self._spans)


class SpanContext:
    """Context manager (sync or async) that opens a span and makes it current."""

    def __init__(
        self,
        name: str,
        kind: SpanKind,
        *,
        input: Any = None,
        attributes: Mapping[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> None:
        self._name = name
        self._kind: SpanKind = kind
        self._input = input
        self._attributes = attributes
        self._tags = tags
        self._span: Span | None = None
        self._token: contextvars.Token[Span | None] | None = None

    def __enter__(self) -> Span:
        parent = _current_span.get()
        span = Span(
            self._name,
            self._kind,
            trace_id=parent.trace_id if parent else new_trace_id(),
            parent_span_id=parent.span_id if parent else None,
            on_end=_export,
            parent=parent,
        )
        if self._input is not None:
            span.set_input(self._input)
        if self._attributes:
            span.set_attributes(self._attributes)
        if self._tags is not None:
            _add_tags(_root_of(span), self._tags)
        if parent is None and (replay := active_replay.get()) is not None:
            replay.tag_root(span)
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

    Usable as ``with tracewright.run(...) as run:`` or ``async with``. Called inside an
    open span (a sub-agent under an orchestrator, or an agent under ``tracewright eval``)
    the run joins that trace as a child ``agent`` span instead, and its tags are added to
    the trace's root span, where the dashboard reads them.
    """
    tag_list = [str(tag) for tag in tags] if tags is not None else None
    return SpanContext(name, "agent", input=input, attributes=attributes, tags=tag_list)


def _root_of(span: Span) -> Span:
    while span.parent is not None:
        span = span.parent
    return span


def _add_tags(root: Span, tags: list[str]) -> None:
    existing = root.attributes.get("tracewright.tags")
    merged = list(existing) if isinstance(existing, list) else []
    merged += [tag for tag in tags if tag not in merged]
    root.set_attribute("tracewright.tags", merged)


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
    options (``@trace(kind="tool")``). Generator functions are not supported. Under
    :func:`tracewright.replay`, ``kind="tool"`` calls may be served from the recording.
    """

    def decorate(fn: Callable[P, R]) -> Callable[P, R]:
        span_name = name or str(getattr(fn, "__name__", "function"))
        signature = _signature_or_none(fn)
        attributes = {"gen_ai.tool.name": span_name} if kind == "tool" else None

        def open_span(call_input: Any) -> SpanContext:
            return SpanContext(span_name, kind, input=call_input, attributes=attributes)

        def bind(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            return _bind_arguments(signature, args, kwargs) if capture_input else None

        def recorded_call(call_input: Any) -> RecordedCall | None:
            """Ask an active replay whether to serve this tool call from the recording."""
            replay = active_replay.get()
            if replay is None or kind != "tool":
                return None
            return replay.plan_call(
                ("tool", span_name, to_jsonable(call_input)), servable=capture_output
            )

        if inspect.iscoroutinefunction(fn):
            async_fn = cast(Callable[..., Awaitable[Any]], fn)

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                call_input = bind(args, kwargs)
                recorded = recorded_call(call_input)
                with open_span(call_input) as current:
                    if recorded is not None:
                        return recorded.serve(current)
                    result = await async_fn(*args, **kwargs)
                    if capture_output:
                        current.set_output(result)
                    return result

            return cast(Callable[P, R], async_wrapper)

        @functools.wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            call_input = bind(args, kwargs)
            recorded = recorded_call(call_input)
            with open_span(call_input) as current:
                if recorded is not None:
                    return cast(R, recorded.serve(current))
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
