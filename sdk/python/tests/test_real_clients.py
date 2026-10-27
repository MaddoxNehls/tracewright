"""Instrumentors against the real SDK clients, served by an offline httpx MockTransport."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

import tracewright
from tracewright.testing import InMemoryExporter

anthropic = pytest.importorskip("anthropic")
openai = pytest.importorskip("openai")
# anthropic>=2 ships on httpx2, a fork with the same API; openai still uses httpx.
httpx2 = pytest.importorskip("httpx2")

ANTHROPIC_BODY = {
    "id": "msg_test",
    "type": "message",
    "role": "assistant",
    "model": "claude-opus-5-5",
    "content": [
        {"type": "text", "text": "Let me search."},
        {"type": "tool_use", "id": "toolu_1", "name": "search", "input": {"q": "apollo"}},
    ],
    "stop_reason": "tool_use",
    "stop_sequence": None,
    "usage": {"input_tokens": 100, "output_tokens": 30},
}

OPENAI_BODY = {
    "id": "gen-test",
    "object": "chat.completion",
    "created": 1761580000,
    "model": "anthropic/claude-sonnet-4.5",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hi there"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12},
}


def respond_with(body: dict[str, Any], http: Any = httpx) -> Any:
    return http.MockTransport(lambda request: http.Response(200, json=body))


def test_real_anthropic_client(exporter: InMemoryExporter) -> None:
    client = anthropic.Anthropic(
        api_key="test",
        http_client=httpx2.Client(transport=respond_with(ANTHROPIC_BODY, httpx2)),
    )
    tracewright.instrument_anthropic(client)

    response = client.messages.create(
        model="claude-opus-5-5",
        max_tokens=100,
        messages=[{"role": "user", "content": "Tell me about Apollo"}],
    )

    assert response.stop_reason == "tool_use"
    (llm,) = exporter.spans
    assert llm["attributes"]["gen_ai.usage.input_tokens"] == 100
    assert llm["attributes"]["gen_ai.response.finish_reasons"] == ["tool_use"]
    assert llm["output"]["content"][1]["name"] == "search"


def test_real_async_anthropic_client(exporter: InMemoryExporter) -> None:
    client = anthropic.AsyncAnthropic(
        api_key="test",
        http_client=httpx2.AsyncClient(transport=respond_with(ANTHROPIC_BODY, httpx2)),
    )
    tracewright.instrument_anthropic(client)

    async def main() -> Any:
        async with tracewright.run("agent"):
            return await client.messages.create(
                model="claude-opus-5-5",
                max_tokens=100,
                messages=[{"role": "user", "content": "hi"}],
            )

    assert asyncio.run(main()).id == "msg_test"
    llm = exporter.by_name("chat claude-opus-5-5")[0]
    assert llm["attributes"]["gen_ai.usage.output_tokens"] == 30


def test_real_openai_client_pointed_at_openrouter(exporter: InMemoryExporter) -> None:
    client = openai.OpenAI(
        api_key="test",
        base_url="https://openrouter.ai/api/v1",
        http_client=httpx.Client(transport=respond_with(OPENAI_BODY)),
    )
    tracewright.instrument_openai(client, provider="openrouter")

    client.chat.completions.create(
        model="anthropic/claude-sonnet-4.5", messages=[{"role": "user", "content": "hi"}]
    )

    (llm,) = exporter.spans
    assert llm["attributes"]["gen_ai.provider.name"] == "openrouter"
    assert llm["attributes"]["gen_ai.usage.input_tokens"] == 9
    assert llm["output"]["content"] == "Hi there"
