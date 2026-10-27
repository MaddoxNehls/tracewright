"""Tracewright: a flight recorder for AI agents.

Typical usage::

    import tracewright

    tracewright.init()  # reads TRACEWRIGHT_API_KEY / TRACEWRIGHT_ENDPOINT
    client = tracewright.instrument_anthropic(anthropic.Anthropic())

    @tracewright.trace(kind="tool")
    def search(query: str) -> list[str]: ...

    with tracewright.run("research", tags=["demo"], input=question) as run:
        ...
        run.set_output(answer)
"""

from tracewright._exporter import Exporter, ExporterStats, HttpExporter, NoopExporter
from tracewright._span import Span, SpanKind, SpanStatus
from tracewright._tracer import (
    SpanContext,
    flush,
    get_current_span,
    init,
    run,
    shutdown,
    span,
    stats,
    trace,
)
from tracewright.instrumentation import instrument_anthropic, instrument_openai

__version__ = "0.1.0"

__all__ = [
    "Exporter",
    "ExporterStats",
    "HttpExporter",
    "NoopExporter",
    "Span",
    "SpanContext",
    "SpanKind",
    "SpanStatus",
    "__version__",
    "flush",
    "get_current_span",
    "init",
    "instrument_anthropic",
    "instrument_openai",
    "run",
    "shutdown",
    "span",
    "stats",
    "trace",
]
