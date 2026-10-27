"""LLM call cost, computed exactly as the ingest service does.

``pricing.json`` is a copy of ``ingest/internal/pricing/pricing.json`` (a test keeps them
identical). Evals compute cost locally so a suite can run, and be compared, without an
ingest service.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Any

_DATED_SUFFIX = re.compile(r"-\d{8}$")


@dataclass(frozen=True)
class Price:
    """USD per million tokens, with an optional higher tier for long prompts."""

    input: float
    output: float
    long_context_above: int | None = None
    long_context_input: float = 0.0
    long_context_output: float = 0.0


class PriceTable:
    def __init__(self, models: Mapping[str, Price]) -> None:
        self._models = dict(models)

    @classmethod
    def default(cls) -> PriceTable:
        text = resources.files("tracewright.eval").joinpath("pricing.json").read_text("utf-8")
        return cls.parse(json.loads(text)["models"])

    @classmethod
    def parse(cls, models: Mapping[str, Any]) -> PriceTable:
        """Build from pricing.json's ``models`` shape: ``{model: {input, output}}``."""
        table: dict[str, Price] = {}
        for model, spec in models.items():
            long_context = spec.get("long_context") or {}
            price = Price(
                input=float(spec["input"]),
                output=float(spec["output"]),
                long_context_above=long_context.get("above_input_tokens"),
                long_context_input=float(long_context.get("input", 0)),
                long_context_output=float(long_context.get("output", 0)),
            )
            if min(price.input, price.output) < 0:
                raise ValueError(f"pricing for {model!r}: prices must be non-negative")
            table[str(model)] = price
        return cls(table)

    def with_overrides(self, models: Mapping[str, Any]) -> PriceTable:
        return PriceTable({**self._models, **PriceTable.parse(models)._models})

    def lookup(self, model: str) -> Price | None:
        # A dated snapshot ("-20251001") is billed like its alias.
        return self._models.get(model) or self._models.get(_DATED_SUFFIX.sub("", model))

    def cost(self, model: str, input_tokens: int, output_tokens: int) -> float | None:
        """USD rounded to 6 places, or None for an unknown model (never a misleading 0)."""
        price = self.lookup(model)
        if price is None:
            return None
        rate_in, rate_out = price.input, price.output
        if price.long_context_above is not None and input_tokens > price.long_context_above:
            rate_in, rate_out = price.long_context_input, price.long_context_output
        return round((input_tokens * rate_in + output_tokens * rate_out) / 1e6, 6)
