"""Shared machinery for wrapping an LLM client's ``create`` method in ``llm`` spans."""

from __future__ import annotations

import functools
import inspect
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from tracewright._span import Span
from tracewright._tracer import SpanContext

logger = logging.getLogger("tracewright")

_MARKER = "__tracewright_instrumented__"


@dataclass
class RequestInfo:
    name: str
    attributes: dict[str, Any] = field(default_factory=dict)
    input: Any = None


class LLMAdapter(Protocol):
    """Translates one provider's request/response shapes into span data."""

    def describe_request(self, kwargs: Mapping[str, Any]) -> RequestInfo: ...

    def record_response(self, span: Span, response: Any) -> None: ...


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

    wrapper: Callable[..., Any]
    if inspect.iscoroutinefunction(inspect.unwrap(original)):

        @functools.wraps(original)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            if kwargs.get("stream"):
                # TODO(milestone 3): instrument streaming responses.
                return await original(*args, **kwargs)
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
            with open_span(kwargs) as span:
                response = original(*args, **kwargs)
                record(span, response)
                return response

        wrapper = sync_wrapper

    setattr(wrapper, _MARKER, True)
    setattr(owner, attr, wrapper)


def drop_none(values: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}
