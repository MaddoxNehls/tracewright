"""Eval suites: a YAML file listing tasks, each with an input and the scorers it must pass.

.. code-block:: yaml

    id: research-agent
    entrypoint: research_agent.evals:answer   # module:function(input) -> output
    pricing:                                   # optional, merged over the built-in prices
      mock-1: {input: 3.0, output: 15.0}
    tasks:
      - id: apollo-gap
        input: {scenario: apollo-gap}
        scorers:
          - contains: "12 calendar years"
          - no_error
          - max_steps: 5
"""

from __future__ import annotations

import importlib
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from tracewright._replay import DEFAULT_STEP_ATTRIBUTE

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


class SuiteError(ValueError):
    """The suite (or thresholds) file is invalid, or a referenced callable can't be loaded."""


@dataclass(frozen=True)
class Task:
    id: str
    input: Any
    scorers: Sequence[Any] = ()
    """Scorer specs as written in YAML; built by :func:`tracewright.eval.scorers.build`."""


@dataclass(frozen=True)
class Suite:
    id: str
    tasks: Sequence[Task]
    entrypoint: str | None = None
    step_attribute: str = DEFAULT_STEP_ATTRIBUTE
    pricing: Mapping[str, Any] = field(default_factory=dict)

    def select(self, task_ids: Sequence[str]) -> Suite:
        """The same suite restricted to ``task_ids`` (all tasks if empty)."""
        if not task_ids:
            return self
        unknown = sorted(set(task_ids) - {t.id for t in self.tasks})
        if unknown:
            raise SuiteError(f"unknown task id(s): {', '.join(unknown)}")
        chosen = [t for t in self.tasks if t.id in task_ids]
        return Suite(self.id, chosen, self.entrypoint, self.step_attribute, self.pricing)


def load_suite(path: str | Path) -> Suite:
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise SuiteError(f"cannot read suite {path}: {exc}") from exc
    return parse_suite(data, source=str(path))


def parse_suite(data: Any, source: str = "suite") -> Suite:
    if not isinstance(data, Mapping):
        raise SuiteError(f"{source}: expected a mapping with 'id' and 'tasks'")
    suite_id = _identifier(data.get("id"), f"{source}: id")
    raw_tasks = data.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise SuiteError(f"{source}: 'tasks' must be a non-empty list")

    tasks: list[Task] = []
    for i, raw in enumerate(raw_tasks):
        where = f"{source}: tasks[{i}]"
        if not isinstance(raw, Mapping):
            raise SuiteError(f"{where} must be a mapping")
        task_id = _identifier(raw.get("id"), f"{where}.id")
        if any(t.id == task_id for t in tasks):
            raise SuiteError(f"{where}: duplicate task id {task_id!r}")
        scorers = raw.get("scorers") or []
        if not isinstance(scorers, list):
            raise SuiteError(f"{where}.scorers must be a list")
        tasks.append(Task(task_id, raw.get("input"), tuple(scorers)))

    entrypoint = data.get("entrypoint")
    if entrypoint is not None and not isinstance(entrypoint, str):
        raise SuiteError(f"{source}: entrypoint must be a 'module:function' string")
    pricing = data.get("pricing") or {}
    if not isinstance(pricing, Mapping):
        raise SuiteError(f"{source}: pricing must map model names to {{input, output}}")
    step_attribute = str(data.get("step_attribute") or DEFAULT_STEP_ATTRIBUTE)
    return Suite(suite_id, tasks, entrypoint, step_attribute, dict(pricing))


def load_callable(spec: str) -> Callable[..., Any]:
    """Import ``module:function`` (dots allowed after the colon for nested attributes)."""
    module_name, sep, attr_path = spec.partition(":")
    if not sep or not module_name or not attr_path:
        raise SuiteError(f"{spec!r} is not of the form 'module:function'")
    try:
        target: Any = importlib.import_module(module_name)
    except ImportError as exc:
        raise SuiteError(f"cannot import {module_name!r} for {spec!r}: {exc}") from exc
    for attr in attr_path.split("."):
        try:
            target = getattr(target, attr)
        except AttributeError:
            raise SuiteError(f"{spec!r}: {module_name} has no attribute {attr_path!r}") from None
    if not callable(target):
        raise SuiteError(f"{spec!r} is not callable")
    return target  # type: ignore[no-any-return]


def _identifier(value: Any, where: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise SuiteError(f"{where} must be a string of letters, digits, '.', '_' or '-'")
    return value
