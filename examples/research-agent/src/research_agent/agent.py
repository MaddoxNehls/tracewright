"""The research agent loop: the model picks a tool, we run it, repeat until it answers."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import tracewright

from research_agent.backends.base import Backend
from research_agent.tools import Toolbox
from research_agent.transcript import Message, ToolResults, UserMessage

SYSTEM_PROMPT = """\
You are a careful research assistant specialising in the history of spaceflight.
Answer the user's question using only facts found with the search_corpus tool; do not rely
on memory for dates or figures. Use the calculator for any arithmetic. When you have a
useful finding, record it with save_note. Finish with a concise answer that names the
articles you relied on."""


class MaxStepsExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentResult:
    answer: str
    steps: int
    trace_id: str


class ResearchAgent:
    def __init__(
        self,
        backend: Backend,
        toolbox: Toolbox | None = None,
        *,
        max_steps: int = 8,
        tags: Sequence[str] = (),
    ) -> None:
        self.backend = backend
        self.toolbox = toolbox or Toolbox()
        self.max_steps = max_steps
        self._tags = list(tags)

    def run(self, question: str) -> AgentResult:
        """Answer ``question``. Each run is one trace; each loop iteration one step span."""
        tags = ["research-agent", f"backend:{self.backend.name}", *self._tags]
        run_input = {
            "question": question,
            "backend": self.backend.name,
            "model": self.backend.model,
        }
        with tracewright.run("research-agent", tags=tags, input=run_input) as run:
            transcript: list[Message] = [UserMessage(question)]
            for step in range(1, self.max_steps + 1):
                with tracewright.span(f"step-{step}", attributes={"agent.step": step}):
                    turn = self.backend.complete(SYSTEM_PROMPT, transcript, self.toolbox.specs)
                    transcript.append(turn)
                    if not turn.tool_calls:
                        run.set_output({"answer": turn.text, "steps": step})
                        return AgentResult(turn.text, step, run.trace_id)
                    results = [self.toolbox.execute(call) for call in turn.tool_calls]
                    transcript.append(ToolResults(results))
            raise MaxStepsExceeded(f"no final answer after {self.max_steps} steps")
