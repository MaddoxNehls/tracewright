"""Auto-instrumentation for OpenAI-compatible chat completion clients (OpenAI, OpenRouter, ...)."""

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

_SYSTEM_ROLES = ("system", "developer")


class _OpenAIAdapter:
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

    def override_system(self, kwargs: dict[str, Any], edit: Callable[[Any], Any]) -> None:
        """Edit the first system (or developer) message, inserting one if there is none."""
        messages = list(kwargs.get("messages") or [])
        for i, message in enumerate(messages):
            if isinstance(message, Mapping) and message.get("role") in _SYSTEM_ROLES:
                messages[i] = {**message, "content": edit(message.get("content"))}
                break
        else:
            messages.insert(0, {"role": "system", "content": edit(None)})
        kwargs["messages"] = messages

    def rebuild_response(self, output: Any, attributes: Mapping[str, Any]) -> Any:
        messages = output if isinstance(output, list) else [output]
        finish_reasons = list(attributes.get("gen_ai.response.finish_reasons") or [])
        input_tokens = attributes.get("gen_ai.usage.input_tokens") or 0
        output_tokens = attributes.get("gen_ai.usage.output_tokens") or 0
        model = attributes.get("gen_ai.response.model") or attributes.get("gen_ai.request.model")
        return rebuild_model(
            "openai.types.chat",
            "ChatCompletion",
            {
                "id": attributes.get("gen_ai.response.id") or "chatcmpl-replayed",
                "object": "chat.completion",
                "created": 0,
                "model": model or "unknown",
                "choices": [
                    {
                        "index": i,
                        "message": message,
                        "finish_reason": finish_reasons[i] if i < len(finish_reasons) else "stop",
                        "logprobs": None,
                    }
                    for i, message in enumerate(messages)
                ],
                "usage": {
                    "prompt_tokens": input_tokens,
                    "completion_tokens": output_tokens,
                    "total_tokens": input_tokens + output_tokens,
                },
            },
        )


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
