"""Regression evals: run a suite of agent tasks, score each run, and compare the results
against a baseline. The ``tracewright eval`` command wraps this API."""

from tracewright.eval.compare import (
    Comparison,
    Limit,
    Thresholds,
    compare,
    load_results,
    load_thresholds,
    parse_thresholds,
    render_markdown,
)
from tracewright.eval.pricing import PriceTable
from tracewright.eval.results import RunOutcome, Score, aggregate, measure, percentile
from tracewright.eval.runner import GitInfo, run_suite
from tracewright.eval.scorers import LLMJudge, Scorer
from tracewright.eval.suite import Suite, SuiteError, Task, load_suite, parse_suite

__all__ = [
    "Comparison",
    "GitInfo",
    "LLMJudge",
    "Limit",
    "PriceTable",
    "RunOutcome",
    "Score",
    "Scorer",
    "Suite",
    "SuiteError",
    "Task",
    "Thresholds",
    "aggregate",
    "compare",
    "load_results",
    "load_suite",
    "load_thresholds",
    "measure",
    "parse_suite",
    "parse_thresholds",
    "percentile",
    "render_markdown",
    "run_suite",
]
