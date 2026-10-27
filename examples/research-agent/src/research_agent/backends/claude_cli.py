"""Claude through the local ``claude -p`` CLI (dev only: it uses the Claude subscription).

The CLI has no native tool-calling hook for our tools, so the transcript is rendered into
a prompt that asks for a single JSON object describing the next action. The call is
recorded as a manual ``llm`` span with provider ``claude-cli``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable, Sequence
from typing import Any

import tracewright

from research_agent.backends.base import BackendError
from research_agent.tools import ToolSpec
from research_agent.transcript import AssistantTurn, Message, ToolCall, to_chat_messages

Runner = Callable[..., "subprocess.CompletedProcess[str]"]

_SAFE_MODEL = re.compile(r"[A-Za-z0-9._\-\[\]]+")

PROTOCOL = """\
You can call these tools:
{tools}

Reply with exactly one JSON object and nothing else, in one of these two forms:
  {{"thought": "<one sentence>", "tool_calls": [{{"name": "<tool>", "arguments": {{...}}}}]}}
  {{"answer": "<final answer for the user>"}}
Do not use any tools of your own; only request the tools listed above."""


class ClaudeCliBackend:
    name = "claude-cli"

    def __init__(
        self,
        model: str | None = None,
        *,
        executable: str = "claude",
        runner: Runner = subprocess.run,
        timeout: float = 300.0,
    ) -> None:
        if model is not None and not _SAFE_MODEL.fullmatch(model):
            raise ValueError(f"invalid model name {model!r}")
        self.model = model or "claude-cli-default"
        self._model_flag = model
        self._executable = executable
        self._runner = runner
        self._timeout = timeout

    def complete(
        self, system: str, transcript: Sequence[Message], tools: Sequence[ToolSpec]
    ) -> AssistantTurn:
        instructions = system + "\n\n" + PROTOCOL.format(tools=_describe_tools(tools))
        prompt = instructions + "\n\n" + render_prompt(transcript)
        attributes: dict[str, Any] = {
            "gen_ai.provider.name": "claude-cli",
            "gen_ai.operation.name": "chat",
        }
        if self._model_flag:
            attributes["gen_ai.request.model"] = self._model_flag
        with tracewright.span(
            f"chat {self.model}",
            kind="llm",
            input={"prompt": prompt},
            attributes=attributes,
        ) as span:
            payload = self._invoke(prompt)
            result = str(payload.get("result", ""))
            span.set_attributes(_usage_attributes(payload))
            span.set_output(result)
        return parse_reply(result, turn=sum(1 for m in transcript if isinstance(m, AssistantTurn)))

    def _invoke(self, prompt: str) -> dict[str, Any]:
        executable = shutil.which(self._executable)  # resolves claude.cmd on Windows
        if executable is None:
            raise BackendError(f"{self._executable!r} not found on PATH")
        # Only fixed flags go on the command line: on Windows `claude` is a .cmd shim, so
        # arguments pass through cmd.exe parsing. All prompt text travels over stdin.
        command = [executable, "-p", "--output-format", "json", "--tools", ""]
        command += ["--no-session-persistence"]
        if self._model_flag:
            command += ["--model", self._model_flag]
        proc = self._runner(
            command,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=self._timeout,
            check=False,
        )
        if proc.returncode != 0:
            raise BackendError(f"claude exited with {proc.returncode}: {proc.stderr.strip()[:500]}")
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise BackendError("claude returned non-JSON output") from exc
        if not isinstance(payload, dict):
            raise BackendError("claude returned an unexpected JSON payload")
        if payload.get("is_error"):
            raise BackendError(f"claude reported an error: {payload.get('result')}")
        return payload


def render_prompt(transcript: Sequence[Message]) -> str:
    lines = ["Conversation so far:"]
    for entry in to_chat_messages(transcript):
        role = entry["role"]
        if role == "user":
            lines.append(f"USER: {entry['content']}")
        elif role == "assistant":
            reply = {"thought": entry["content"], "tool_calls": entry.get("tool_calls", [])}
            lines.append(f"ASSISTANT: {json.dumps(reply)}")
        else:
            status = "ERROR" if entry["is_error"] else "OK"
            lines.append(f"TOOL RESULT ({entry['name']}, {status}): {entry['content']}")
    lines.append("\nRespond with the JSON object for your next action.")
    return "\n".join(lines)


_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


def parse_reply(text: str, *, turn: int) -> AssistantTurn:
    """Parse the protocol JSON. Anything unparseable is treated as a final answer."""
    match = _JSON_OBJECT.search(text)
    try:
        reply = json.loads(match.group(0)) if match else None
    except json.JSONDecodeError:
        reply = None
    if not isinstance(reply, dict):
        return AssistantTurn(text.strip())
    if "answer" in reply:
        return AssistantTurn(str(reply["answer"]))
    calls = [
        ToolCall(f"call_{turn + 1}_{i}", str(c.get("name", "")), dict(c.get("arguments") or {}))
        for i, c in enumerate(reply.get("tool_calls") or [])
        if isinstance(c, dict)
    ]
    return AssistantTurn(str(reply.get("thought", "")), calls)


def _describe_tools(tools: Sequence[ToolSpec]) -> str:
    return "\n".join(
        f"- {t.name}: {t.description} Arguments schema: {json.dumps(t.input_schema)}" for t in tools
    )


def _usage_attributes(payload: dict[str, Any]) -> dict[str, Any]:
    usage = payload.get("usage") or {}
    # Claude Code's own system prompt is mostly served from cache; count it as input.
    input_tokens = sum(
        int(usage.get(key) or 0)
        for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    )
    attributes: dict[str, Any] = {
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.output_tokens": int(usage.get("output_tokens") or 0),
        "gen_ai.response.finish_reasons": [str(payload.get("stop_reason") or "end_turn")],
    }
    models = list((payload.get("modelUsage") or {}).keys())
    if models:
        attributes["gen_ai.response.model"] = models[0]
    if isinstance(payload.get("total_cost_usd"), (int, float)):
        attributes["tracewright.cost_usd"] = float(payload["total_cost_usd"])
    return attributes
