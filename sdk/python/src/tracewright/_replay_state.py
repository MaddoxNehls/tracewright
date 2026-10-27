"""The active replay, kept apart from ``_replay`` so the tracer and instrumentation can
consult it without an import cycle."""

from __future__ import annotations

import contextvars
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tracewright._replay import Replay

active_replay: contextvars.ContextVar[Replay | None] = contextvars.ContextVar(
    "tracewright_active_replay", default=None
)
