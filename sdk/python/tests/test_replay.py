"""Replay against a fake read API: a run is recorded in memory, then served back over
an ``httpx.MockTransport`` exactly as ``GET /v1/runs/{trace_id}`` would return it."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from anthropic.types import Message
from openai.types.chat import ChatCompletion

import tracewright
from tracewright.testing import InMemoryExporter

API_KEY = "tw_" + "0" * 32


# --- a tiny agent: each step asks the model for a query, then looks it up -----------------


class ScriptedMessages:
    """An Anthropic-shaped client whose reply depends on the request, like a real model."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def reply(self, **kwargs: Any) -> Message:
        self.calls.append(kwargs)
        step = sum(m["role"] == "assistant" for m in kwargs["messages"]) + 1
        careful = "HINT" in str(kwargs.get("system")) or kwargs["model"] == "m-2"
        query = f"q{step}" if careful or step != 2 else "bad q2"
        return Message.model_validate(
            {
                "id": f"msg_{step}",
                "type": "message",
                "role": "assistant",
                "model": kwargs["model"],
                "content": [{"type": "text", "text": query}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 10 * step, "output_tokens": 3},
            }
        )

    def create(self, **kwargs: Any) -> Message:
        return self.reply(**kwargs)


class AsyncScriptedMessages(ScriptedMessages):
    async def create(self, **kwargs: Any) -> Message:  # type: ignore[override]
        await asyncio.sleep(0)
        return self.reply(**kwargs)


class Tools:
    def __init__(self) -> None:
        self.calls: list[str] = []

    @tracewright.trace(kind="tool")
    def lookup(self, query: str) -> dict[str, Any]:
        self.calls.append(query)
        if query.startswith("bad"):
            raise ValueError(f"cannot parse {query!r}")
        return {"query": query, "hits": len(query)}

    @tracewright.trace(kind="tool")
    async def alookup(self, query: str) -> dict[str, Any]:
        await asyncio.sleep(0)
        return self.lookup.__wrapped__(self, query)  # type: ignore[attr-defined,no-any-return]


def run_agent(
    client: Any, tools: Tools, *, steps: int = 3, extra_lookup_in_step: int | None = None
) -> list[str]:
    """Returns one line per step; a tool error is fed back to the model, not raised."""
    lines = []
    with tracewright.run("agent", input={"question": "q"}):
        messages: list[dict[str, Any]] = [{"role": "user", "content": "q"}]
        for step in range(1, steps + 1):
            with tracewright.span(f"step-{step}", attributes={"agent.step": step}):
                response = client.messages.create(
                    model="m-1", max_tokens=50, system="Be brief.", messages=messages
                )
                query = response.content[0].text
                try:
                    result = f"{tools.lookup(query)['hits']} hits"
                except Exception as exc:
                    result = f"{type(exc).__name__}: {exc}"
                if step == extra_lookup_in_step:
                    tools.lookup("extra")
                lines.append(f"{query} -> {result}")
                messages += [
                    {"role": "assistant", "content": query},
                    {"role": "user", "content": result},
                ]
    return lines


async def run_agent_async(client: Any, tools: Tools, *, steps: int = 3) -> list[str]:
    lines = []
    async with tracewright.run("agent"):
        messages: list[dict[str, Any]] = [{"role": "user", "content": "q"}]
        for step in range(1, steps + 1):
            async with tracewright.span(f"step-{step}", attributes={"agent.step": step}):
                response = await client.messages.create(
                    model="m-1", max_tokens=50, system="Be brief.", messages=messages
                )
                query = response.content[0].text
                try:
                    result = f"{(await tools.alookup(query))['hits']} hits"
                except Exception as exc:
                    result = f"{type(exc).__name__}: {exc}"
                lines.append(f"{query} -> {result}")
                messages += [
                    {"role": "assistant", "content": query},
                    {"role": "user", "content": result},
                ]
    return lines


# --- fixtures: record once, serve it through a fake read API -----------------------------


class Recorded(SimpleNamespace):
    trace_id: str
    lines: list[str]
    transport: httpx.MockTransport
    requests: list[httpx.Request]


def read_api(spans: list[dict[str, Any]]) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    trace_id = spans[0]["trace_id"]
    ordered = sorted(spans, key=lambda s: (s["start_time"], s["span_id"]))
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.headers.get("Authorization") != f"Bearer {API_KEY}":
            return httpx.Response(401, json={"error": "missing or invalid API key"})
        if request.url.path != f"/v1/runs/{trace_id}":
            return httpx.Response(404, json={"error": "run not found"})
        return httpx.Response(200, json={"run": {"trace_id": trace_id}, "spans": ordered})

    return httpx.MockTransport(handle), requests


@pytest.fixture
def recorded(exporter: InMemoryExporter) -> Recorded:
    """The original run: step 2's query is malformed, so its lookup fails."""
    client = tracewright.instrument_anthropic(SimpleNamespace(messages=ScriptedMessages()))
    lines = run_agent(client, Tools())
    assert lines == ["q1 -> 2 hits", "bad q2 -> ValueError: cannot parse 'bad q2'", "q3 -> 2 hits"]
    spans = exporter.spans
    exporter.clear()
    transport, requests = read_api(spans)
    return Recorded(
        trace_id=spans[0]["trace_id"], lines=lines, transport=transport, requests=requests
    )


def fresh_client(messages: ScriptedMessages | None = None) -> tuple[Any, ScriptedMessages]:
    messages = messages or ScriptedMessages()
    return tracewright.instrument_anthropic(SimpleNamespace(messages=messages)), messages


def replay(recorded: Recorded, **options: Any) -> tracewright.Replay:
    options.setdefault("api_key", API_KEY)
    return tracewright.replay(recorded.trace_id, transport=recorded.transport, **options)


def step_children(exporter: InMemoryExporter, step: int) -> list[dict[str, Any]]:
    (step_span,) = exporter.by_name(f"step-{step}")
    return exporter.children_of(step_span["span_id"])


# --- tests ---------------------------------------------------------------------------------


def test_recorded_steps_make_zero_client_or_tool_calls(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, messages = fresh_client()
    tools = Tools()

    with replay(recorded, from_step=4) as r:
        lines = run_agent(client, tools)

    assert lines == recorded.lines  # same answers, the failed lookup included
    assert messages.calls == []
    assert tools.calls == []
    assert (r.served_calls, r.live_calls, r.divergence) == (6, 0, None)
    assert recorded.requests[0].headers["Authorization"] == f"Bearer {API_KEY}"

    for span in exporter.spans:
        if span["kind"] in ("llm", "tool") or span["name"].startswith("step-"):
            assert span["attributes"]["tracewright.replayed"] is True, span["name"]


def test_new_trace_is_tagged_as_a_replay(exporter: InMemoryExporter, recorded: Recorded) -> None:
    client, _ = fresh_client()
    with replay(recorded, from_step=2, overrides={"model": "m-2"}, tools="live") as r:
        run_agent(client, Tools())

    (root,) = exporter.roots()
    assert root["trace_id"] == r.trace_id != recorded.trace_id
    assert root["attributes"]["tracewright.replay_of"] == recorded.trace_id
    assert root["attributes"]["tracewright.replay_from_step"] == 2
    assert root["attributes"]["tracewright.replay_tools"] == "live"
    assert root["attributes"]["tracewright.replay_overrides"] == {"model": "m-2"}
    assert {s["trace_id"] for s in exporter.spans} == {r.trace_id}


def test_served_llm_span_mirrors_the_recording_at_no_cost(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, _ = fresh_client()
    with replay(recorded, from_step=2):
        run_agent(client, Tools(), steps=1)

    llm, tool = step_children(exporter, 1)
    assert llm["name"] == "chat m-1"
    assert llm["attributes"]["gen_ai.usage.input_tokens"] == 10
    assert llm["attributes"]["gen_ai.response.id"] == "msg_1"
    assert llm["attributes"]["tracewright.cost_usd"] == 0
    assert llm["attributes"]["tracewright.replay_source_span_id"]
    assert llm["output"]["content"][0]["text"] == "q1"
    assert tool["output"] == {"query": "q1", "hits": 2}


def test_goes_live_at_from_step_with_overrides(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, messages = fresh_client()
    tools = Tools()
    overrides = {"model": "m-3", "system_append": "HINT", "temperature": 0.2, "top_k": 5}

    with replay(recorded, from_step=2, overrides=overrides) as r:
        lines = run_agent(client, tools)

    # Step 1 came from the recording; from step 2 the hint makes the model behave.
    assert lines == ["q1 -> 2 hits", "q2 -> 2 hits", "q3 -> 2 hits"]
    assert len(messages.calls) == 2
    for call in messages.calls:
        assert call["model"] == "m-3"
        assert call["system"] == "Be brief.\n\nHINT"
        assert call["temperature"] == 0.2
        assert call["top_k"] == 5
        assert call["max_tokens"] == 50  # untouched kwargs pass through
    assert tools.calls == ["q2", "q3"]

    # Step 2's lookup asked for "q2" where the recording has "bad q2": the run diverged.
    assert r.divergence is not None
    assert (r.divergence.step, r.divergence.position) == (2, 2)
    assert r.divergence.expected == ("tool", "lookup", {"query": "bad q2"})
    assert "step 2, call 2" in str(r.divergence)
    assert (r.served_calls, r.live_calls) == (2, 4)

    llm2 = step_children(exporter, 2)[0]
    assert llm2["name"] == "chat m-3"
    assert "tracewright.replayed" not in llm2["attributes"]
    assert exporter.by_name("step-1")[0]["attributes"]["tracewright.replayed"] is True
    assert exporter.by_name("step-2")[0]["attributes"]["tracewright.replayed"] is False


def test_tools_with_identical_arguments_are_served_after_from_step(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, messages = fresh_client()
    tools = Tools()

    with replay(recorded, from_step=3) as r:  # step 3 asks for "q3" again
        lines = run_agent(client, tools)

    assert lines == recorded.lines
    assert len(messages.calls) == 1  # the LLM always goes live from step 3
    assert tools.calls == []  # but its unchanged lookup comes from the recording
    assert r.divergence is None
    llm3, tool3 = step_children(exporter, 3)
    assert "tracewright.replayed" not in llm3["attributes"]
    assert tool3["attributes"]["tracewright.replayed"] is True


def test_tools_live_executes_every_tool_from_step(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, _ = fresh_client()
    tools = Tools()

    with replay(recorded, from_step=3, tools="live") as r:
        run_agent(client, tools)

    assert tools.calls == ["q3"]
    assert (r.served_calls, r.live_calls) == (4, 2)


def test_recorded_errors_are_raised_again_under_their_original_name(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, _ = fresh_client()
    tools = Tools()

    with replay(recorded, from_step=3):
        lines = run_agent(client, tools)

    assert lines[1] == "bad q2 -> ValueError: cannot parse 'bad q2'"
    assert tools.calls == []
    failed = step_children(exporter, 2)[1]
    assert failed["status"] == "error"
    assert failed["error"] == {"type": "ValueError", "message": "cannot parse 'bad q2'"}
    assert failed["attributes"]["tracewright.replayed"] is True


def test_divergence_before_from_step_makes_everything_after_live(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, messages = fresh_client()
    tools = Tools()

    with replay(recorded, from_step=4) as r:
        run_agent(client, tools, extra_lookup_in_step=1)

    # The extra lookup has no counterpart in step 1, so nothing after it can be trusted.
    assert r.divergence is not None
    assert (r.divergence.step, r.divergence.position, r.divergence.expected) == (1, 3, None)
    assert tools.calls == ["extra", "bad q2", "q3"]
    assert len(messages.calls) == 2  # steps 2 and 3 went live
    assert exporter.by_name("step-1")[0]["attributes"]["tracewright.replayed"] is False


def test_leaving_a_step_early_is_a_divergence(recorded: Recorded) -> None:
    client, messages = fresh_client()

    class NoLookups(Tools):
        def lookup(self, query: str) -> dict[str, Any]:  # untraced: no tool span
            return {"hits": 0}

    with replay(recorded, from_step=4) as r:
        run_agent(client, NoLookups())

    assert r.divergence is not None
    assert (r.divergence.step, r.divergence.position) == (1, 2)
    assert r.divergence.actual is None
    assert len(messages.calls) == 2


def test_async_replay(exporter: InMemoryExporter) -> None:
    client = tracewright.instrument_anthropic(SimpleNamespace(messages=AsyncScriptedMessages()))
    original = asyncio.run(run_agent_async(client, Tools()))
    spans = exporter.spans
    exporter.clear()
    transport, _ = read_api(spans)

    messages = AsyncScriptedMessages()
    client = tracewright.instrument_anthropic(SimpleNamespace(messages=messages))
    tools = Tools()

    async def main() -> tuple[list[str], tracewright.Replay]:
        async with tracewright.replay(
            spans[0]["trace_id"],
            from_step=2,
            overrides={"system": "HINT"},
            api_key=API_KEY,
            transport=transport,
        ) as r:
            return await run_agent_async(client, tools), r

    lines, r = asyncio.run(main())

    assert original[1].startswith("bad q2")
    assert lines == ["q1 -> 2 hits", "q2 -> 2 hits", "q3 -> 2 hits"]
    assert [c["system"] for c in messages.calls] == ["HINT", "HINT"]
    assert tools.calls == ["q2", "q3"]
    assert r.served_calls == 2
    assert exporter.roots()[0]["attributes"]["tracewright.replay_of"] == spans[0]["trace_id"]


def test_custom_step_resolver(exporter: InMemoryExporter) -> None:
    def turns(name: str, attributes: Any) -> int | None:
        return int(name.removeprefix("turn ")) if name.startswith("turn ") else None

    tools = Tools()

    def agent() -> None:
        with tracewright.run("agent"):
            for n in (1, 2):
                with tracewright.span(f"turn {n}"):
                    tools.lookup(f"q{n}")

    agent()
    transport, _ = read_api(exporter.spans)
    trace_id = exporter.spans[0]["trace_id"]
    tools.calls.clear()

    with tracewright.replay(
        trace_id, from_step=2, tools="live", step=turns, api_key=API_KEY, transport=transport
    ) as r:
        agent()

    assert tools.calls == ["q2"]
    assert (r.served_calls, r.live_calls) == (1, 1)


def test_openai_replay_rebuilds_completions_and_overrides_the_system_message(
    exporter: InMemoryExporter,
) -> None:
    class Completions:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        def create(self, **kwargs: Any) -> ChatCompletion:
            self.calls.append(kwargs)
            return ChatCompletion.model_validate(
                {
                    "id": "chatcmpl-1",
                    "object": "chat.completion",
                    "created": 1,
                    "model": kwargs["model"],
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": f"#{len(self.calls)}"},
                        }
                    ],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 1, "total_tokens": 8},
                }
            )

    def agent(completions: Completions) -> list[str]:
        client = tracewright.instrument_openai(
            SimpleNamespace(chat=SimpleNamespace(completions=completions))
        )
        out = []
        with tracewright.run("agent"):
            for step in (1, 2):
                with tracewright.span(f"step-{step}", attributes={"agent.step": step}):
                    response = client.chat.completions.create(
                        model="gpt-x",
                        messages=[
                            {"role": "system", "content": "Be brief."},
                            {"role": "user", "content": "hi"},
                        ],
                    )
                    out.append(response.choices[0].message.content)
        return out

    assert agent(Completions()) == ["#1", "#2"]
    transport, _ = read_api(exporter.spans)
    trace_id = exporter.spans[0]["trace_id"]

    completions = Completions()
    with tracewright.replay(
        trace_id,
        from_step=2,
        overrides={"system_append": "Use plain numbers."},
        api_key=API_KEY,
        transport=transport,
    ):
        answers = agent(completions)

    assert answers == ["#1", "#1"]  # step 1 from the recording; step 2 is the first live call
    (call,) = completions.calls
    assert call["messages"][0] == {"role": "system", "content": "Be brief.\n\nUse plain numbers."}


@pytest.mark.parametrize(
    ("current", "overrides", "expected"),
    [
        ("Be brief.", {"system": "New."}, "New."),
        ("Be brief.", {"system": "New.", "system_append": "More."}, "New.\n\nMore."),
        (None, {"system_append": "More."}, "More."),
        (
            [{"type": "text", "text": "Be brief.", "cache_control": {"type": "ephemeral"}}],
            {"system_append": "More."},
            [
                {"type": "text", "text": "Be brief.", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "More."},
            ],
        ),
    ],
)
def test_system_overrides(current: Any, overrides: dict[str, Any], expected: Any) -> None:
    def override_system(kwargs: dict[str, Any], edit: Callable[[Any], Any]) -> None:
        kwargs["system"] = edit(kwargs.get("system"))

    request = {"model": "m-1"} if current is None else {"model": "m-1", "system": current}
    applied = tracewright.Overrides.coerce(overrides).apply(request, override_system)
    assert applied["system"] == expected
    assert request.get("system") == current  # the caller's kwargs are not mutated


def test_openai_system_override_inserts_a_system_message() -> None:
    from tracewright.instrumentation.openai import _OpenAIAdapter

    request = {"messages": [{"role": "user", "content": "hi"}]}
    applied = tracewright.Overrides(system="Be kind.").apply(
        request, _OpenAIAdapter("openai").override_system
    )
    assert applied["messages"] == [
        {"role": "system", "content": "Be kind."},
        {"role": "user", "content": "hi"},
    ]


def test_overrides_are_redacted_on_the_root_span() -> None:
    overrides = tracewright.Overrides.coerce(
        {
            "model": "m-2",
            "max_tokens": 100,
            "api_key": "anything",
            "extra_headers": {"Authorization": "Bearer abc", "X-Trace": "ok"},
            "metadata": {"note": "sk-ant-123", "user": "maddox"},
        }
    )
    assert overrides.describe() == {
        "model": "m-2",
        "max_tokens": 100,
        "api_key": "[redacted]",
        "extra_headers": {"Authorization": "[redacted]", "X-Trace": "ok"},
        "metadata": {"note": "[redacted]", "user": "maddox"},
    }


def test_unknown_run_is_a_clear_error(recorded: Recorded) -> None:
    with (
        pytest.raises(tracewright.ReplayError, match="not found"),
        tracewright.replay("f" * 32, from_step=1, api_key=API_KEY, transport=recorded.transport),
    ):
        pass


def test_replay_requires_an_api_key() -> None:
    tracewright.init()  # no key configured anywhere
    with (
        pytest.raises(tracewright.ReplayError, match="API key"),
        tracewright.replay("a" * 32, from_step=1),
    ):
        pass


@pytest.mark.parametrize(
    ("trace_id", "options", "message"),
    [
        ("not-a-trace", {"from_step": 1}, "trace_id"),
        ("a" * 32, {"from_step": 0}, "from_step"),
        ("a" * 32, {"from_step": 1, "tools": "sometimes"}, "tools"),
    ],
)
def test_invalid_arguments(trace_id: str, options: dict[str, Any], message: str) -> None:
    with pytest.raises(tracewright.ReplayError, match=message):
        tracewright.replay(trace_id, **options)


def test_replay_is_inactive_outside_the_block(
    exporter: InMemoryExporter, recorded: Recorded
) -> None:
    client, messages = fresh_client()
    with replay(recorded, from_step=4):
        pass
    run_agent(client, Tools())

    assert len(messages.calls) == 3
    assert "tracewright.replay_of" not in exporter.roots()[0]["attributes"]
