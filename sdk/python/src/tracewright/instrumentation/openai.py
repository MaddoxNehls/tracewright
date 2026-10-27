"""Auto-instrumentation for OpenAI-compatible chat completion clients (OpenAI, OpenRouter, ...)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from tracewright._span import Span
from tracewright.instrumentation._common import RequestInfo, drop_none, patch_create

ClientT = TypeVar("ClientT")


class _OpenAIAdapter:
    def __init__(self, provider: str) -> None:
        self._provider = provider

    def describe_request(self, kwargs: Mapping[str, Any]) -> RequestInfo:
        model = kwargs.get("model")
        return RequestInfo(
            name=f"chat {model}" if model else "chat",
            attributes=drop_none(
                {
                    "gen_ai.provider.name": self._provider,
                    "gen_ai.operation.name": "chat",
                    "gen_ai.request.model": model,
                    "gen_ai.request.max_tokens": kwargs.get("max_tokens")
                    or kwargs.get("max_completion_tokens"),
                    "gen_ai.request.temperature": kwargs.get("temperature"),
                }
            ),
            input=drop_none({"messages": kwargs.get("messages"), "tools": kwargs.get("tools")}),
        )

    def record_response(self, span: Span, response: Any) -> None:
        usage = getattr(response, "usage", None)
        choices = list(getattr(response, "choices", None) or [])
        finish_reasons = [c.finish_reason for c in choices if getattr(c, "finish_reason", None)]
        span.set_attributes(
            drop_none(
                {
                    "gen_ai.response.model": getattr(response, "model", None),
                    "gen_ai.response.id": getattr(response, "id", None),
                    "gen_ai.usage.input_tokens": getattr(usage, "prompt_tokens", None),
                    "gen_ai.usage.output_tokens": getattr(usage, "completion_tokens", None),
                    "gen_ai.response.finish_reasons": finish_reasons or None,
                }
            )
        )
        messages = [getattr(c, "message", None) for c in choices]
        span.set_output(messages[0] if len(messages) == 1 else messages)


def instrument_openai(client: ClientT, provider: str = "openai") -> ClientT:
    """Record every non-streaming ``client.chat.completions.create`` call as an ``llm`` span.

    Pass ``provider="openrouter"`` (or similar) for OpenAI-compatible gateways so the
    span carries the right ``gen_ai.provider.name``.
    """
    patch_create(
        client.chat.completions,  # type: ignore[attr-defined]
        "create",
        _OpenAIAdapter(provider),
        fallback_name="chat",
    )
    return client
