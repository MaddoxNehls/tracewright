"""Auto-instrumentation for ``anthropic.Anthropic`` and ``anthropic.AsyncAnthropic``."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from tracewright._span import Span
from tracewright.instrumentation._common import RequestInfo, drop_none, patch_create

ClientT = TypeVar("ClientT")

PROVIDER = "anthropic"


class _AnthropicAdapter:
    def describe_request(self, kwargs: Mapping[str, Any]) -> RequestInfo:
        model = kwargs.get("model")
        return RequestInfo(
            name=f"chat {model}" if model else "chat",
            attributes=drop_none(
                {
                    "gen_ai.provider.name": PROVIDER,
                    "gen_ai.operation.name": "chat",
                    "gen_ai.request.model": model,
                    "gen_ai.request.max_tokens": kwargs.get("max_tokens"),
                    "gen_ai.request.temperature": kwargs.get("temperature"),
                }
            ),
            input=drop_none(
                {
                    "system": kwargs.get("system"),
                    "messages": kwargs.get("messages"),
                    "tools": kwargs.get("tools"),
                }
            ),
        )

    def record_response(self, span: Span, response: Any) -> None:
        usage = getattr(response, "usage", None)
        stop_reason = getattr(response, "stop_reason", None)
        span.set_attributes(
            drop_none(
                {
                    "gen_ai.response.model": getattr(response, "model", None),
                    "gen_ai.response.id": getattr(response, "id", None),
                    "gen_ai.usage.input_tokens": getattr(usage, "input_tokens", None),
                    "gen_ai.usage.output_tokens": getattr(usage, "output_tokens", None),
                    "gen_ai.response.finish_reasons": [stop_reason] if stop_reason else None,
                }
            )
        )
        span.set_output({"role": "assistant", "content": getattr(response, "content", None)})


def instrument_anthropic(client: ClientT) -> ClientT:
    """Record every non-streaming ``client.messages.create`` call as an ``llm`` span.

    Works for both sync and async clients and returns the same client for chaining.
    """
    patch_create(client.messages, "create", _AnthropicAdapter(), fallback_name="chat")  # type: ignore[attr-defined]
    return client
