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

    # Would a new system prompt have fixed a recorded run? Replay it from step 3.
    with tracewright.replay(trace_id, from_step=3, overrides={"system_append": "..."}):
        agent.run(question)
"""

from tracewright._exporter import Exporter, ExporterStats, HttpExporter, NoopExporter
from tracewright._replay import (
    Divergence,
    Overrides,
    Replay,
    ReplayedError,
    ReplayError,
    replay,
    step_attribute,
)
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
    "Divergence",
    "Exporter",
    "ExporterStats",
    "HttpExporter",
    "NoopExporter",
    "Overrides",
    "Replay",
    "ReplayError",
    "ReplayedError",
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
    "replay",
    "run",
    "shutdown",
    "span",
    "stats",
    "step_attribute",
    "trace",
]
