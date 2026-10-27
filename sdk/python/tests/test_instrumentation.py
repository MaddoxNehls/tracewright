"""Instrumentors exercised against fake clients shaped like the anthropic/openai SDKs."""

from __future__ import annotations

import asyncio
import functools
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest

import tracewright
from tracewright.testing import InMemoryExporter


class FakeModel(SimpleNamespace):
    """Stands in for the pydantic models the real SDKs return."""

    def model_dump(self, mode: str = "python") -> dict[str, Any]:
        return dict(vars(self))


def anthropic_response(**overrides: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "id": "msg_01",
        "model": "claude-opus-5-5",
        "stop_reason": "end_turn",
        "content": [FakeModel(type="text", text="Hello!")],
        "usage": SimpleNamespace(input_tokens=12, output_tokens=5),
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


def sdk_style_wrapper(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Mimics anthropic's ``required_args``: a sync wrapper around an async def."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    return wrapper


class FakeMessages:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._response = response or anthropic_response()
        self._error = error

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return "<stream>" if kwargs.get("stream") else self._response


class FakeAsyncMessages(FakeMessages):
    @sdk_style_wrapper
    async def create(self, **kwargs: Any) -> Any:  # type: ignore[override]
        await asyncio.sleep(0)
        return super().create(**kwargs)


class FakeAnthropic:
    def __init__(self, messages: FakeMessages | None = None) -> None:
        self.messages = messages or FakeMessages()


class FakeCompletions:
    def __init__(self, response: Any) -> None:
        self._response = response

    def create(self, **kwargs: Any) -> Any:
        return self._response


class FakeAsyncCompletions(FakeCompletions):
    async def create(self, **kwargs: Any) -> Any:  # type: ignore[override]
        return self._response


def fake_openai(completions: FakeCompletions) -> SimpleNamespace:
    return SimpleNamespace(chat=SimpleNamespace(completions=completions))


def openai_response() -> SimpleNamespace:
    message = FakeModel(role="assistant", content="4", tool_calls=None)
    return SimpleNamespace(
        id="gen-1",
        model="openai/gpt-4o-mini",
        choices=[SimpleNamespace(index=0, message=message, finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=20, completion_tokens=1),
    )


REQUEST = {
    "model": "claude-opus-5-5",
    "max_tokens": 256,
    "system": "Be brief.",
    "messages": [{"role": "user", "content": "Hi"}],
}


def test_anthropic_sync_call_is_recorded(exporter: InMemoryExporter) -> None:
    client = tracewright.instrument_anthropic(FakeAnthropic())

    with tracewright.run("agent") as run:
        response = client.messages.create(**REQUEST)

    assert response.content[0].text == "Hello!"
    llm = exporter.by_name("chat claude-opus-5-5")[0]
    assert llm["kind"] == "llm"
    assert llm["parent_span_id"] == run.span_id
    assert llm["attributes"] == {
        "gen_ai.provider.name": "anthropic",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-opus-5-5",
        "gen_ai.request.max_tokens": 256,
        "gen_ai.response.model": "claude-opus-5-5",
        "gen_ai.response.id": "msg_01",
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 5,
        "gen_ai.response.finish_reasons": ["end_turn"],
    }
    assert llm["input"] == {"system": "Be brief.", "messages": REQUEST["messages"]}
    assert llm["output"] == {
        "role": "assistant",
        "content": [{"type": "text", "text": "Hello!"}],
    }


def test_anthropic_async_client_is_recorded(exporter: InMemoryExporter) -> None:
    client = tracewright.instrument_anthropic(FakeAnthropic(FakeAsyncMessages()))

    async def main() -> Any:
        async with tracewright.run("agent"):
            return await client.messages.create(**REQUEST)

    response = asyncio.run(main())

    assert response.id == "msg_01"
    llm = exporter.by_name("chat claude-opus-5-5")[0]
    assert llm["attributes"]["gen_ai.usage.output_tokens"] == 5


def test_anthropic_error_is_recorded_and_reraised(exporter: InMemoryExporter) -> None:
    messages = FakeMessages(error=TimeoutError("upstream timeout"))
    client = tracewright.instrument_anthropic(FakeAnthropic(messages))

    with pytest.raises(TimeoutError):
        client.messages.create(**REQUEST)

    (llm,) = exporter.spans
    assert llm["status"] == "error"
    assert llm["error"] == {"type": "TimeoutError", "message": "upstream timeout"}


def test_anthropic_streaming_passes_through_untraced(exporter: InMemoryExporter) -> None:
    client = tracewright.instrument_anthropic(FakeAnthropic())

    assert client.messages.create(**REQUEST, stream=True) == "<stream>"
    assert exporter.spans == []


def test_instrumenting_twice_does_not_double_wrap(exporter: InMemoryExporter) -> None:
    client = tracewright.instrument_anthropic(tracewright.instrument_anthropic(FakeAnthropic()))
    client.messages.create(**REQUEST)
    assert len(exporter.spans) == 1


def test_malformed_response_never_breaks_the_call(exporter: InMemoryExporter) -> None:
    class Hostile:
        @property
        def usage(self) -> Any:
            raise RuntimeError("bad property")

    hostile = Hostile()
    client = tracewright.instrument_anthropic(FakeAnthropic(FakeMessages(response=hostile)))

    assert client.messages.create(**REQUEST) is hostile
    assert exporter.spans[0]["status"] == "ok"


@pytest.mark.parametrize("provider", ["openai", "openrouter"])
def test_openai_compatible_call_is_recorded(exporter: InMemoryExporter, provider: str) -> None:
    client = tracewright.instrument_openai(
        fake_openai(FakeCompletions(openai_response())), provider=provider
    )

    client.chat.completions.create(
        model="openai/gpt-4o-mini", messages=[{"role": "user", "content": "2+2?"}]
    )

    (llm,) = exporter.spans
    assert llm["name"] == "chat openai/gpt-4o-mini"
    assert llm["attributes"]["gen_ai.provider.name"] == provider
    assert llm["attributes"]["gen_ai.usage.input_tokens"] == 20
    assert llm["attributes"]["gen_ai.usage.output_tokens"] == 1
    assert llm["attributes"]["gen_ai.response.finish_reasons"] == ["stop"]
    assert llm["output"] == {"role": "assistant", "content": "4", "tool_calls": None}


def test_openai_async_client_is_recorded(exporter: InMemoryExporter) -> None:
    client = tracewright.instrument_openai(fake_openai(FakeAsyncCompletions(openai_response())))

    asyncio.run(client.chat.completions.create(model="gpt-4o-mini", messages=[]))

    assert exporter.spans[0]["attributes"]["gen_ai.response.model"] == "openai/gpt-4o-mini"
