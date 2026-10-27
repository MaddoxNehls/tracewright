"""Auto-instrumentation for ``anthropic.Anthropic`` and ``anthropic.AsyncAnthropic``."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, TypeVar

from tracewright._span import Span
from tracewright.instrumentation._common import (
    RequestInfo,
    drop_none,
    patch_create,
    rebuild_model,
)

ClientT = TypeVar("ClientT")


class _AnthropicAdapter:
    def __init__(self, provider: str) -> None:
        self.provider = provider

    def describe_request(self, kwargs: Mapping[str, Any]) -> RequestInfo:
        model = kwargs.get("model")
        return RequestInfo(
            name=f"chat {model}" if model else "chat",
            attributes=drop_none(
                {
                    "gen_ai.provider.name": self.provider,
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

    def override_system(self, kwargs: dict[str, Any], edit: Callable[[Any], Any]) -> None:
        kwargs["system"] = edit(kwargs.get("system"))

    def rebuild_response(self, output: Any, attributes: Mapping[str, Any]) -> Any:
        content = output.get("content") if isinstance(output, Mapping) else None
        finish_reasons = attributes.get("gen_ai.response.finish_reasons") or [None]
        model = attributes.get("gen_ai.response.model") or attributes.get("gen_ai.request.model")
        return rebuild_model(
            "anthropic.types",
            "Message",
            {
                "id": attributes.get("gen_ai.response.id") or "msg_replayed",
                "type": "message",
                "role": "assistant",
                "model": model or "unknown",
                "content": content or [],
                "stop_reason": finish_reasons[0],
                "stop_sequence": None,
                "usage": {
                    "input_tokens": attributes.get("gen_ai.usage.input_tokens") or 0,
                    "output_tokens": attributes.get("gen_ai.usage.output_tokens") or 0,
                },
            },
        )


def instrument_anthropic(client: ClientT, provider: str = "anthropic") -> ClientT:
    """Record every non-streaming ``client.messages.create`` call as an ``llm`` span.

    Works for both sync and async clients and returns the same client for chaining.
    ``provider`` sets ``gen_ai.provider.name``, for Anthropic-compatible endpoints.
    """
    patch_create(
        client.messages,  # type: ignore[attr-defined]
        "create",
        _AnthropicAdapter(provider),
        fallback_name="chat",
    )
    return client
