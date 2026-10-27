"""The results data model: one :class:`RunOutcome` per execution of a task, rolled up per
task and per suite. Everything here is pure, so it is easy to test and reuse."""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from tracewright._replay import StepResolver
from tracewright.eval.pricing import PriceTable

TaskStatus = Literal["pass", "fail", "flaky"]
RESULTS_VERSION = 1


@dataclass(frozen=True)
class Score:
    scorer: str
    passed: bool | None  # None: the scorer was skipped (e.g. the llm_judge stub)
    detail: str = ""


@dataclass
class RunOutcome:
    """What one execution of a task did, measured from its trace."""

    input: Any
    output: Any
    trace_id: str
    error: dict[str, str] | None  # the entrypoint raised
    latency_ms: float
    steps: int = 0
    llm_calls: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    span_errors: list[dict[str, str]] = field(default_factory=list)
    scores: list[Score] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def passed(self) -> bool:
        """A run passes if the entrypoint returned and no scorer failed."""
        return self.error is None and all(s.passed is not False for s in self.scores)

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "passed": self.passed, "tokens": self.tokens}


def measure(
    spans: Sequence[Mapping[str, Any]], prices: PriceTable, step_of: StepResolver
) -> dict[str, Any]:
    """Steps, calls, tokens, cost and span errors of one trace, from wire-format spans.

    Cost follows ingest: an explicit ``tracewright.cost_usd`` wins, otherwise it comes
    from the price table; unpriced calls are skipped, and if nothing is priced the cost
    is None rather than 0.
    """
    steps = llm_calls = tool_calls = input_tokens = output_tokens = 0
    costs: list[float] = []
    span_errors: list[dict[str, str]] = []
    for span in spans:
        attributes = span.get("attributes") or {}
        if step_of(span["name"], attributes) is not None:
            steps += 1
        if span["kind"] == "tool":
            tool_calls += 1
        if span["kind"] == "llm":
            llm_calls += 1
            tokens_in = _int(attributes.get("gen_ai.usage.input_tokens"))
            tokens_out = _int(attributes.get("gen_ai.usage.output_tokens"))
            input_tokens += tokens_in
            output_tokens += tokens_out
            cost = _span_cost(attributes, tokens_in, tokens_out, prices)
            if cost is not None:
                costs.append(cost)
        # Agent spans only repeat the error of whatever raised inside them.
        if span["status"] == "error" and span["kind"] != "agent":
            error = span.get("error") or {}
            span_errors.append(
                {
                    "span": span["name"],
                    "type": str(error.get("type", "")),
                    "message": str(error.get("message", "")),
                }
            )
    return {
        "steps": steps,
        "llm_calls": llm_calls,
        "tool_calls": tool_calls,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": round(sum(costs), 6) if costs else None,
        "span_errors": span_errors,
    }


def _span_cost(
    attributes: Mapping[str, Any], tokens_in: int, tokens_out: int, prices: PriceTable
) -> float | None:
    explicit = attributes.get("tracewright.cost_usd")
    if isinstance(explicit, (int, float)) and not isinstance(explicit, bool):
        return float(explicit)
    model = attributes.get("gen_ai.response.model") or attributes.get("gen_ai.request.model")
    return prices.cost(str(model), tokens_in, tokens_out) if model else None


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def percentile(values: Sequence[float], q: float) -> float | None:
    """Linear-interpolated percentile (as numpy's default); None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * q / 100
    low, high = math.floor(rank), math.ceil(rank)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def task_summary(task_id: str, task_input: Any, runs: Sequence[RunOutcome]) -> dict[str, Any]:
    """Roll up a task's runs. Under ``--repeat`` a task that sometimes passes is flaky."""
    passes = sum(r.passed for r in runs)
    status: TaskStatus = "pass" if passes == len(runs) else "fail" if passes == 0 else "flaky"
    costs = [r.cost_usd for r in runs if r.cost_usd is not None]
    return {
        "id": task_id,
        "input": task_input,
        "status": status,
        "passes": passes,
        "repeat": len(runs),
        "metrics": {  # medians over the repeats
            "cost_usd": statistics.median(costs) if costs else None,
            "latency_ms": statistics.median(r.latency_ms for r in runs),
            "input_tokens": statistics.median(r.input_tokens for r in runs),
            "output_tokens": statistics.median(r.output_tokens for r in runs),
            "tokens": statistics.median(r.tokens for r in runs),
            "steps": statistics.median(r.steps for r in runs),
        },
        "runs": [r.to_dict() for r in runs],
    }


def aggregate(tasks: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Suite-level numbers over task summaries (percentiles are over every run)."""
    runs = [run for task in tasks for run in task["runs"]]
    costs = [r["cost_usd"] for r in runs if r["cost_usd"] is not None]
    latencies = [r["latency_ms"] for r in runs]
    statuses = [task["status"] for task in tasks]
    input_tokens = sum(r["input_tokens"] for r in runs)
    output_tokens = sum(r["output_tokens"] for r in runs)
    return {
        "tasks": len(tasks),
        "passed_tasks": statuses.count("pass"),
        "failed_tasks": statuses.count("fail"),
        "flaky_tasks": statuses.count("flaky"),
        "pass_rate": statuses.count("pass") / len(tasks) if tasks else None,
        "runs": len(runs),
        "passed_runs": sum(r["passed"] for r in runs),
        "cost_usd": {
            "total": round(sum(costs), 6) if costs else None,
            "p50": _round(percentile(costs, 50), 6),
            "p95": _round(percentile(costs, 95), 6),
        },
        "latency_ms": {
            "p50": _round(percentile(latencies, 50), 3),
            "p95": _round(percentile(latencies, 95), 3),
        },
        "tokens": {
            "input": input_tokens,
            "output": output_tokens,
            "total": input_tokens + output_tokens,
        },
        "steps": {"total": sum(r["steps"] for r in runs)},
    }
