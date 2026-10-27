"""Replay a recorded run: serve calls from the recording up to a step, then go live.

How a live call is matched to the recording
-------------------------------------------
Only *calls* are replayed: ``llm`` spans from the instrumented Anthropic/OpenAI clients
and ``tool`` spans from ``@trace(kind="tool")``. Each one belongs to the innermost
enclosing *step* span; within a step, calls are numbered in start order. The k-th call of
step s in the live run is matched against the k-th recorded call of step s, and the two
must have the same signature:

- llm: ``("llm", provider)``
- tool: ``("tool", name, arguments)``, arguments compared as JSON

A call that matches is served from the recording when its step is before ``from_step``,
or when it is a tool call, ``tools="recorded"``, and its arguments are unchanged. Every
other call runs live, with the overrides applied to LLM requests.

The first mismatch (a different signature, an extra call, or leaving a step before all
of its recorded calls were made) marks the replay as *diverged*. From then on the
recording no longer describes what the live run is doing, so every later call runs live.
Calls outside any step, and calls nested inside another call, are never matched; they
run live.
"""

from __future__ import annotations

import re
import threading
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any, Literal, TypeVar, cast

import httpx

from tracewright._replay_state import active_replay
from tracewright._span import Span
from tracewright._tracer import configured_credentials, get_current_span

ToolsMode = Literal["recorded", "live"]
StepResolver = Callable[[str, Mapping[str, Any]], int | None]
"""Maps a span's ``(name, attributes)`` to its step number, or None if it isn't a step."""

DEFAULT_STEP_ATTRIBUTE = "agent.step"
RUNS_PATH = "/v1/runs/"

_CALL_KINDS = ("llm", "tool")
_TRACE_ID = re.compile(r"[0-9a-f]{32}")


def step_attribute(key: str = DEFAULT_STEP_ATTRIBUTE) -> StepResolver:
    """Treat spans carrying an integer attribute ``key`` as steps numbered by its value."""

    def resolve(name: str, attributes: Mapping[str, Any]) -> int | None:
        value = attributes.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    return resolve


class ReplayError(RuntimeError):
    """The recording could not be loaded, or the replay was configured incorrectly."""


class ReplayedError(Exception):
    """Raised in place of the exception a recorded call raised.

    Each recorded error type gets its own subclass named after it, so code that formats
    ``type(exc).__name__`` sees the same name as in the original run. ``except`` clauses
    for the original class will not catch it.
    """

    error_type = "ReplayedError"


_error_classes: dict[str, type[ReplayedError]] = {}


def _replayed_error(error: Mapping[str, Any] | None) -> ReplayedError:
    error_type = str((error or {}).get("type") or "ReplayedError")
    cls = _error_classes.get(error_type)
    if cls is None:
        cls = type(error_type, (ReplayedError,), {"error_type": error_type})
        _error_classes[error_type] = cls
    return cls(str((error or {}).get("message") or ""))


# --- overrides ----------------------------------------------------------------------------

_OVERRIDE_FIELDS = ("model", "system", "system_append", "temperature")


@dataclass(frozen=True)
class Overrides:
    """Changes applied to every LLM request that runs live during a replay.

    ``system`` replaces the system prompt; ``system_append`` adds text after it (both may
    be given). ``params`` are any other request keyword arguments, applied last.
    """

    model: str | None = None
    system: str | None = None
    system_append: str | None = None
    temperature: float | None = None
    params: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def coerce(cls, value: Overrides | Mapping[str, Any] | None) -> Overrides:
        """Build from a plain dict: known fields by name, everything else into ``params``."""
        if value is None:
            return cls()
        if isinstance(value, Overrides):
            return value
        known = {k: value[k] for k in _OVERRIDE_FIELDS if k in value}
        params = {k: v for k, v in value.items() if k not in _OVERRIDE_FIELDS}
        return cls(**known, params=params)

    def apply(
        self,
        kwargs: Mapping[str, Any],
        override_system: Callable[[dict[str, Any], Callable[[Any], Any]], None],
    ) -> dict[str, Any]:
        """Return a copy of a request's kwargs with the overrides applied."""
        request = dict(kwargs)
        if self.model is not None:
            request["model"] = self.model
        if self.temperature is not None:
            request["temperature"] = self.temperature
        if self.system is not None or self.system_append:
            override_system(request, self._edit_system)
        request.update(self.params)
        return request

    def _edit_system(self, current: Any) -> Any:
        system = self.system if self.system is not None else current
        if not self.system_append:
            return system
        if isinstance(system, list):  # content blocks: keep them intact, add one
            return [*system, {"type": "text", "text": self.system_append}]
        return f"{system}\n\n{self.system_append}" if system else self.system_append

    def describe(self) -> dict[str, Any]:
        """The overrides as a span attribute value, with secret-looking values redacted."""
        fields = {k: getattr(self, k) for k in _OVERRIDE_FIELDS if getattr(self, k) is not None}
        return cast(dict[str, Any], redact({**fields, **self.params}))


_SECRET_KEY_PARTS = frozenset(
    {"key", "apikey", "secret", "password", "passwd", "token", "auth", "authorization",
     "credential", "credentials", "cookie"}
)  # fmt: skip
_SECRET_VALUE = re.compile(r"^(sk|pk|rk|tw)[-_]|^bearer\s|^gh[pousr]_|^xox[abprs]-", re.IGNORECASE)
REDACTED = "[redacted]"


def redact(value: Any, key: str | None = None) -> Any:
    """Replace values under secret-looking keys, and secret-looking strings, with a marker.

    Keys are split into words, so ``api_key`` and ``Authorization`` are redacted but
    ``max_tokens`` is not.
    """
    if key is not None and _SECRET_KEY_PARTS.intersection(re.split(r"[^a-z0-9]+", key.lower())):
        return REDACTED
    if isinstance(value, Mapping):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str) and _SECRET_VALUE.search(value):
        return REDACTED
    return value


# --- the recording ------------------------------------------------------------------------


@dataclass(frozen=True)
class RecordedCall:
    """One recorded llm or tool call, as returned by the read API."""

    span_id: str
    kind: str
    signature: tuple[Any, ...]
    status: str
    error: Mapping[str, Any] | None
    output: Any
    attributes: Mapping[str, Any]

    @property
    def servable(self) -> bool:
        """A truncated output can't stand in for the real one."""
        return not self.attributes.get("tracewright.truncated")

    def serve(self, span: Span) -> Any:
        """Fill ``span`` from the recording and return the recorded output.

        Raises a :class:`ReplayedError` if the recorded call failed.
        """
        span.set_attributes({k: v for k, v in self.attributes.items() if k.startswith("gen_ai.")})
        span.set_attributes(
            {"tracewright.replayed": True, "tracewright.replay_source_span_id": self.span_id}
        )
        if self.kind == "llm":
            span.set_attribute("tracewright.cost_usd", 0)  # nothing was spent this time
        span.set_output(self.output)
        if self.status == "error":
            raise _replayed_error(self.error)
        return self.output


def signature_of(
    kind: str, name: str, attributes: Mapping[str, Any], input: Any
) -> tuple[Any, ...]:
    if kind == "llm":
        return ("llm", attributes.get("gen_ai.provider.name"))
    return ("tool", name, input)


@dataclass(frozen=True)
class Recording:
    """A recorded run, indexed for replay: ``calls[step]`` lists that step's calls in order."""

    trace_id: str
    run: Mapping[str, Any]
    spans: Sequence[Mapping[str, Any]]
    calls: Mapping[int, Sequence[RecordedCall]]

    @property
    def root(self) -> Mapping[str, Any] | None:
        return next((s for s in self.spans if s.get("parent_span_id") is None), None)

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any], step_of: StepResolver) -> Recording:
        """Index a ``GET /v1/runs/{trace_id}`` response. Spans arrive in start order."""
        spans: list[Mapping[str, Any]] = list(payload.get("spans") or [])
        by_id = {s["span_id"]: s for s in spans}
        calls: dict[int, list[RecordedCall]] = defaultdict(list)
        for s in spans:
            if s["kind"] not in _CALL_KINDS:
                continue
            located = _enclosing_step(_recorded_ancestors(s, by_id), step_of)
            if located is None:
                continue
            attributes = s.get("attributes") or {}
            calls[located[0]].append(
                RecordedCall(
                    span_id=s["span_id"],
                    kind=s["kind"],
                    signature=signature_of(s["kind"], s["name"], attributes, s.get("input")),
                    status=s["status"],
                    error=s.get("error"),
                    output=s.get("output"),
                    attributes=attributes,
                )
            )
        run = payload.get("run") or {}
        return cls(str(run.get("trace_id", "")), run, spans, dict(calls))


_Node = TypeVar("_Node")
_Ancestor = tuple[_Node, str, str, Mapping[str, Any]]  # (node, kind, name, attributes)


def _enclosing_step(
    ancestors: Iterable[_Ancestor[_Node]], step_of: StepResolver
) -> tuple[int, _Node] | None:
    """The innermost step around a call; None if it is outside any step or inside another call."""
    for node, kind, name, attributes in ancestors:
        if kind in _CALL_KINDS:
            return None
        step = step_of(name, attributes)
        if step is not None:
            return step, node
    return None


def _live_ancestors(span: Span | None) -> Iterator[_Ancestor[Span]]:
    while span is not None:
        yield span, span.kind, span.name, span.attributes
        span = span.parent


def _recorded_ancestors(
    span: Mapping[str, Any], by_id: Mapping[str, Mapping[str, Any]]
) -> Iterator[_Ancestor[Mapping[str, Any]]]:
    parent = by_id.get(span.get("parent_span_id") or "")
    while parent is not None:
        yield parent, parent["kind"], parent["name"], parent.get("attributes") or {}
        parent = by_id.get(parent.get("parent_span_id") or "")


# --- the replay session -------------------------------------------------------------------


@dataclass(frozen=True)
class Divergence:
    """Where the live run stopped following the recording (``position`` is 1-based)."""

    step: int
    position: int
    expected: tuple[Any, ...] | None
    actual: tuple[Any, ...] | None

    def __str__(self) -> str:
        def show(signature: tuple[Any, ...] | None) -> str:
            return " ".join(map(str, signature)) if signature else "nothing"

        return (
            f"step {self.step}, call {self.position}: recorded {show(self.expected)}, "
            f"live {show(self.actual)}"
        )


class Replay:
    """A replay in progress; create it with :func:`tracewright.replay`.

    After the run, ``trace_id`` is the new trace, ``served_calls`` and ``live_calls``
    count how each call was handled, and ``divergence`` says where (if anywhere) the live
    run left the recording.
    """

    def __init__(
        self,
        trace_id: str,
        *,
        from_step: int,
        overrides: Overrides | Mapping[str, Any] | None = None,
        tools: ToolsMode = "recorded",
        step: str | StepResolver = DEFAULT_STEP_ATTRIBUTE,
        api_key: str | None = None,
        endpoint: str | None = None,
        transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not _TRACE_ID.fullmatch(trace_id):
            raise ReplayError(f"trace_id must be 32 lowercase hex characters, got {trace_id!r}")
        if from_step < 1:
            raise ReplayError(f"from_step must be at least 1, got {from_step}")
        if tools not in ("recorded", "live"):
            raise ReplayError(f'tools must be "recorded" or "live", got {tools!r}')
        self.original_trace_id = trace_id
        self.from_step = from_step
        self.overrides = Overrides.coerce(overrides)
        self.tools: ToolsMode = tools
        self._step_of = step_attribute(step) if isinstance(step, str) else step
        self._api_key = api_key
        self._endpoint = endpoint
        self._transport = transport

        self.recording: Recording | None = None
        self.trace_id: str | None = None
        self.served_calls = 0
        self.live_calls = 0
        self.divergence: Divergence | None = None

        self._lock = threading.Lock()
        self._cursors: dict[int, int] = defaultdict(int)
        self._current_step: int | None = None
        self._step_fully_served: dict[str, bool] = {}
        self._token: Any = None

    # Context management: load the recording, then activate for this context.

    def __enter__(self) -> Replay:
        transport = self._transport
        if transport is not None and not isinstance(transport, httpx.BaseTransport):
            raise TypeError("a synchronous replay needs an httpx.BaseTransport")
        url, headers = self._request()
        try:
            with httpx.Client(transport=transport, timeout=30.0) as client:
                response = client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise ReplayError(f"could not load run {self.original_trace_id}: {exc}") from exc
        self._activate(response)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        active_replay.reset(self._token)

    async def __aenter__(self) -> Replay:
        transport = self._transport
        if transport is not None and not isinstance(transport, httpx.AsyncBaseTransport):
            raise TypeError("an async replay needs an httpx.AsyncBaseTransport")
        url, headers = self._request()
        try:
            async with httpx.AsyncClient(transport=transport, timeout=30.0) as client:
                response = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise ReplayError(f"could not load run {self.original_trace_id}: {exc}") from exc
        self._activate(response)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.__exit__(exc_type, exc, tb)

    def _request(self) -> tuple[str, dict[str, str]]:
        default_key, default_endpoint = configured_credentials()
        api_key = self._api_key or default_key
        if not api_key:
            raise ReplayError(
                "replay reads the recording from Tracewright and needs an API key: "
                "pass api_key=, call tracewright.init(api_key=...), or set TRACEWRIGHT_API_KEY"
            )
        endpoint = (self._endpoint or default_endpoint).rstrip("/")
        return endpoint + RUNS_PATH + self.original_trace_id, {"Authorization": f"Bearer {api_key}"}

    def _activate(self, response: httpx.Response) -> None:
        if response.status_code == 404:
            raise ReplayError(
                f"run {self.original_trace_id} not found: check that it belongs to this API "
                "key's project and has finished ingesting"
            )
        if not response.is_success:
            raise ReplayError(
                f"could not load run {self.original_trace_id}: HTTP {response.status_code} "
                f"{response.text[:200]}"
            )
        self.recording = Recording.from_payload(response.json(), self._step_of)
        self._token = active_replay.set(self)

    # Hooks called by the tracer and the instrumentation while the replay is active.

    def tag_root(self, span: Span) -> None:
        """Mark a new run's root span as a replay of the original."""
        if self.trace_id is None:
            self.trace_id = span.trace_id
        span.set_attributes(
            {
                "tracewright.replay_of": self.original_trace_id,
                "tracewright.replay_from_step": self.from_step,
                "tracewright.replay_tools": self.tools,
                "tracewright.replay_overrides": self.overrides.describe(),
            }
        )

    def plan_call(
        self, signature: tuple[Any, ...], *, servable: bool = True
    ) -> RecordedCall | None:
        """Decide how the call about to start under the current span is handled.

        Returns the recorded call to serve in its place, or None to run it live.
        ``servable=False`` means the caller can't use a recorded output (it doesn't capture
        one), so the call runs live even if it matches.
        """
        located = _enclosing_step(_live_ancestors(get_current_span()), self._step_of)
        with self._lock:
            served = self._match(located, signature) if located else None
            if served is not None and not (servable and served.servable):
                served = None
            if served is None:
                self.live_calls += 1
            else:
                self.served_calls += 1
            if located is not None:
                self._mark_step(located[1], served is not None)
        return served

    def _match(self, located: tuple[int, Span], signature: tuple[Any, ...]) -> RecordedCall | None:
        assert self.recording is not None
        step = located[0]
        calls = self.recording.calls
        if self._current_step is not None and step != self._current_step:
            left = self._current_step
            left_calls = calls.get(left, ())
            if self.divergence is None and self._cursors[left] < len(left_calls):
                pos = self._cursors[left]
                self.divergence = Divergence(left, pos + 1, left_calls[pos].signature, None)
        self._current_step = step
        if self.divergence is not None:
            return None

        position = self._cursors[step]
        self._cursors[step] += 1
        step_calls = calls.get(step, ())
        expected = step_calls[position] if position < len(step_calls) else None
        if expected is None or expected.signature != signature:
            self.divergence = Divergence(
                step, position + 1, expected.signature if expected else None, signature
            )
            return None
        if step < self.from_step:
            return expected
        if expected.kind == "tool" and self.tools == "recorded":
            return expected
        return None

    def _mark_step(self, step_span: Span, served: bool) -> None:
        """A step is marked replayed while every call in it has been served."""
        fully_served = self._step_fully_served.get(step_span.span_id, True) and served
        self._step_fully_served[step_span.span_id] = fully_served
        step_span.set_attribute("tracewright.replayed", fully_served)


def replay(
    trace_id: str,
    *,
    from_step: int,
    overrides: Overrides | Mapping[str, Any] | None = None,
    tools: ToolsMode = "recorded",
    step: str | StepResolver = DEFAULT_STEP_ATTRIBUTE,
    api_key: str | None = None,
    endpoint: str | None = None,
    transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
) -> Replay:
    """Re-run a recorded run, served from the recording before ``from_step`` and live after.

    Use as ``with tracewright.replay(...) as r:`` (or ``async with``) around one run of
    your agent. Steps before ``from_step`` get their LLM responses and tool results from
    the recording without calling the client or the tool. From ``from_step`` on, LLM calls
    go live with ``overrides`` applied (``model``, ``system``, ``system_append``,
    ``temperature``, or any other request kwarg), and tool calls are served from the
    recording only if ``tools="recorded"`` and the name and arguments match exactly.

    Steps are spans whose ``agent.step`` attribute holds the step number; pass ``step``
    to use another attribute name or a ``(name, attributes) -> int | None`` function.
    The new run is a new trace whose root span carries ``tracewright.replay_of``. See the
    module docstring for the exact matching rules.
    """
    return Replay(
        trace_id,
        from_step=from_step,
        overrides=overrides,
        tools=tools,
        step=step,
        api_key=api_key,
        endpoint=endpoint,
        transport=transport,
    )
