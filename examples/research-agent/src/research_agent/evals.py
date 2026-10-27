"""The entrypoint and custom scorer used by the dogfood eval suite (``evals/suite.yaml``).

Tasks always use the deterministic mock backend, so the suite runs in CI with no API keys
and its numbers only change when the agent's behaviour does.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

# Import the Anthropic types up front: the mock imports them on first use, and that
# one-off cost (about a second) would otherwise land in the first task's latency.
import anthropic.types  # noqa: F401
from tracewright.eval import RunOutcome

from research_agent.agent import SYSTEM_PROMPT, ResearchAgent
from research_agent.backends.mock import DOUBLE_CHECK_ENV, MockBackend


def answer(task: Mapping[str, Any]) -> str:
    """Run one task: ``{scenario, model?, question?, system_append?}`` -> the final answer."""
    backend = MockBackend(
        task["scenario"],
        model=task.get("model", "mock-1"),
        double_check=os.environ.get(DOUBLE_CHECK_ENV) == "1",
    )
    system = SYSTEM_PROMPT
    if task.get("system_append"):
        system += "\n\n" + task["system_append"]
    agent = ResearchAgent(backend, system_prompt=system, tags=[f"scenario:{task['scenario']}"])
    return agent.run(task.get("question") or backend.scenario.question).answer


_SOURCES = re.compile(r"Sources?: ([a-z0-9-]+(?:, [a-z0-9-]+)*)\.?$")


def cites_sources(run: RunOutcome) -> tuple[bool, str]:
    """The answer ends by naming the corpus articles it relied on."""
    match = _SOURCES.search(str(run.output or ""))
    if match is None:
        return False, "no 'Sources: ...' line at the end of the answer"
    return True, match.group(1)
