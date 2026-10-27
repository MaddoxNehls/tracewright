"""Scorers check one run of a task. In a suite each is a YAML list item:

=====================================  =================================================
``contains: "text"``                   the output contains the text
``regex: "\\d+ days"``                 the output matches (``re.search``)
``equals: <any value>``                the output equals the value (JSON equality)
``no_error`` / ``no_error: run``       no span errored, recovered tool errors included /
                                       only the run itself must not fail
``max_steps: 5``                       at most this many step spans
``max_cost_usd: 0.05``                 cost at most this (fails if the cost is unknown)
``python: "pkg.module:function"``      ``function(run)`` returns a bool or (bool, detail)
``llm_judge: {criteria: "..."}``       not implemented yet: skipped (see :class:`LLMJudge`)
=====================================  =================================================

String and regex scorers see the output as-is if it is a string, else as JSON.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from typing import Any, Protocol

from tracewright.eval.results import RunOutcome, Score
from tracewright.eval.suite import SuiteError, load_callable

Scorer = Callable[[RunOutcome], Score]


class LLMJudge(Protocol):
    """The interface an LLM-as-judge scorer will use. No implementation ships yet, so
    ``llm_judge`` scorers are reported as skipped and never call a model."""

    def judge(self, *, criteria: str, input: Any, output: Any) -> tuple[bool, str]: ...


def build(spec: Any, *, judge: LLMJudge | None = None) -> Scorer:
    """Turn one YAML scorer spec (``"no_error"`` or ``{kind: argument}``) into a scorer."""
    if isinstance(spec, str):
        kind, arg = spec, True
    elif isinstance(spec, Mapping) and len(spec) == 1:
        ((kind, arg),) = spec.items()
    else:
        raise SuiteError(f"scorer {spec!r} must be a name or a single-key mapping")
    factory = _FACTORIES.get(kind)
    if factory is None:
        raise SuiteError(f"unknown scorer {kind!r}; choose from {', '.join(sorted(_FACTORIES))}")
    if kind == "llm_judge":
        return _llm_judge(arg, judge)
    return factory(arg)


def output_text(output: Any) -> str:
    return output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)


def _label(kind: str, arg: Any) -> str:
    return kind if arg is True else f"{kind}: {json.dumps(arg, ensure_ascii=False)}"


def _contains(arg: Any) -> Scorer:
    text = _require(arg, str, "contains")
    label = _label("contains", text)
    return lambda run: Score(label, text in output_text(run.output))


def _regex(arg: Any) -> Scorer:
    try:
        pattern = re.compile(_require(arg, str, "regex"))
    except re.error as exc:
        raise SuiteError(f"regex {arg!r} is invalid: {exc}") from exc
    label = _label("regex", arg)
    return lambda run: Score(label, pattern.search(output_text(run.output)) is not None)


def _equals(arg: Any) -> Scorer:
    label = _label("equals", arg)

    def score(run: RunOutcome) -> Score:
        passed = run.output == arg
        return Score(label, passed, "" if passed else f"got {output_text(run.output)[:200]}")

    return score


def _no_error(arg: Any) -> Scorer:
    if arg not in (True, "run", "spans"):
        raise SuiteError("no_error takes no argument, or 'run' to ignore recovered span errors")
    run_only = arg == "run"

    def score(run: RunOutcome) -> Score:
        errors = [] if run_only else run.span_errors
        if run.error:
            errors = [{"span": "run", **run.error}, *errors]
        detail = "; ".join(f"{e['span']}: {e['type']}: {e['message']}" for e in errors)
        return Score(_label("no_error", arg), not errors, detail)

    return score


def _max_steps(arg: Any) -> Scorer:
    limit = _require(arg, int, "max_steps")

    def score(run: RunOutcome) -> Score:
        return Score(_label("max_steps", limit), run.steps <= limit, f"{run.steps} steps")

    return score


def _max_cost(arg: Any) -> Scorer:
    limit = float(_require(arg, (int, float), "max_cost_usd"))

    def score(run: RunOutcome) -> Score:
        label = _label("max_cost_usd", arg)
        if run.cost_usd is None:
            return Score(label, False, "cost unknown: no priced LLM calls")
        return Score(label, run.cost_usd <= limit, f"${run.cost_usd:.6f}")

    return score


def _python(arg: Any) -> Scorer:
    label = _label("python", arg)
    function = load_callable(_require(arg, str, "python"))

    def score(run: RunOutcome) -> Score:
        try:
            result = function(run)
        except Exception as exc:
            return Score(label, False, f"scorer raised {type(exc).__name__}: {exc}")
        if isinstance(result, tuple):
            passed, detail = result
            return Score(label, bool(passed), str(detail))
        return Score(label, bool(result))

    return score


def _llm_judge(arg: Any, judge: LLMJudge | None) -> Scorer:
    criteria = arg.get("criteria") if isinstance(arg, Mapping) else arg
    criteria = _require(criteria, str, "llm_judge criteria")
    label = _label("llm_judge", criteria)

    def score(run: RunOutcome) -> Score:
        if judge is None:
            return Score(label, None, "skipped: no LLM judge is configured")
        passed, detail = judge.judge(criteria=criteria, input=run.input, output=run.output)
        return Score(label, passed, detail)

    return score


def _require(value: Any, types: type | tuple[type, ...], name: str) -> Any:
    if not isinstance(value, types) or isinstance(value, bool):
        raise SuiteError(f"{name} got {value!r}")
    return value


_FACTORIES: dict[str, Callable[[Any], Scorer]] = {
    "contains": _contains,
    "regex": _regex,
    "equals": _equals,
    "no_error": _no_error,
    "max_steps": _max_steps,
    "max_cost_usd": _max_cost,
    "python": _python,
    "llm_judge": lambda arg: _llm_judge(arg, None),
}
