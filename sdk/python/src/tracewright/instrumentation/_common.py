"""Shared machinery for wrapping an LLM client's ``create`` method in ``llm`` spans."""

from __future__ import annotations

import functools
import importlib
import inspect
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Protocol

from tracewright._replay_state import active_replay
from tracewright._span import Span
from tracewright._tracer import SpanContext

if TYPE_CHECKING:
    from tracewright._replay import RecordedCall

logger = logging.getLogger("tracewright")

_MARKER = "__tracewright_instrumented__"


@dataclass
class RequestInfo:
    name: str
    attributes: dict[str, Any] = field(default_factory=dict)
    input: Any = None


class LLMAdapter(Protocol):
    """Translates one provider's request/response shapes into span data, and back."""

    provider: str

    def describe_request(self, kwargs: Mapping[str, Any]) -> RequestInfo: ...

    def record_response(self, span: Span, response: Any) -> None: ...

    def override_system(self, kwargs: dict[str, Any], edit: Callable[[Any], Any]) -> None:
        """Replace the request's system prompt with ``edit(current)``, in place."""

    def rebuild_response(self, output: Any, attributes: Mapping[str, Any]) -> Any:
        """Reconstruct a client response object from a recorded span, for replay."""


def patch_create(owner: object, attr: str, adapter: LLMAdapter, fallback_name: str) -> None:
    """Replace ``owner.<attr>`` with a traced wrapper. Idempotent.

    Extraction errors inside the adapter are logged and swallowed: a bug in tracing must
    never change what the host's LLM call returns or raises.
    """
    original = getattr(owner, attr)
    if getattr(original, _MARKER, False):
        return

    def open_span(kwargs: Mapping[str, Any]) -> SpanContext:
        try:
            info = adapter.describe_request(kwargs)
        except Exception:
            logger.debug("tracewright: failed to describe LLM request", exc_info=True)
            info = RequestInfo(name=fallback_name)
        return SpanContext(info.name, "llm", input=info.input, attributes=info.attributes)

    def record(span: Span, response: Any) -> None:
        try:
            adapter.record_response(span, response)
        except Exception:
            logger.debug("tracewright: failed to record LLM response", exc_info=True)

    def plan(kwargs: dict[str, Any]) -> tuple[RecordedCall | None, dict[str, Any]]:
        """Under replay, pick the recorded call to serve, or apply the overrides to go live."""
        replay = active_replay.get()
        if replay is None:
            return None, kwargs
        recorded = replay.plan_call(("llm", adapter.provider))
        if recorded is None:
            return None, replay.overrides.apply(kwargs, adapter.override_system)
        return recorded, kwargs

    def serve(kwargs: Mapping[str, Any], recorded: RecordedCall) -> Any:
        with open_span(kwargs) as span:
            recorded.serve(span)  # raises the recorded error, if the call failed
            return adapter.rebuild_response(recorded.output, recorded.attributes)

    wrapper: Callable[..., Any]
    if inspect.iscoroutinefunction(inspect.unwrap(original)):

        @functools.wraps(original)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get("stream"):
                # TODO(milestone 3): instrument streaming responses.
                return await original(*args, **kwargs)
            recorded, kwargs = plan(kwargs)
            if recorded is not None:
                return serve(kwargs, recorded)
            with open_span(kwargs) as span:
                response = await original(*args, **kwargs)
                record(span, response)
                return response

        wrapper = async_wrapper
    else:

        @functools.wraps(original)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get("stream"):
                # TODO(milestone 3): instrument streaming responses.
                return original(*args, **kwargs)
            recorded, kwargs = plan(kwargs)
            if recorded is not None:
                return serve(kwargs, recorded)
            with open_span(kwargs) as span:
                response = original(*args, **kwargs)
                record(span, response)
                return response

        wrapper = sync_wrapper

    setattr(wrapper, _MARKER, True)
    setattr(owner, attr, wrapper)


def drop_none(values: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


def rebuild_model(module: str, name: str, data: dict[str, Any]) -> Any:
    """Validate recorded JSON back into a provider SDK model such as ``anthropic.types.Message``.

    Falls back to nested namespaces (same attribute access, no methods) when the SDK isn't
    installed or the recorded data no longer validates against it.
    """
    try:
        model = getattr(importlib.import_module(module), name)
        return model.model_validate(data)
    except Exception:
        logger.debug("tracewright: replaying %s.%s as a namespace", module, name, exc_info=True)
        return _namespace(data)


def _namespace(value: Any) -> Any:
    if isinstance(value, Mapping):
        return SimpleNamespace(**{str(k): _namespace(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_namespace(v) for v in value]
    return value
