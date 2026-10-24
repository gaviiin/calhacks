"""Claude API plumbing shared by the agents (official `anthropic` SDK, verified against 2.3.0).

Rules for this model (claude-opus-5-5, override with CCD_MODEL):
  - no forced tool_choice (HTTP 400): tool_choice is left at auto and the prompt says what to call;
  - thinking is always on: never send `thinking`, never send budget_tokens;
  - depth via output_config={"effort": "medium"};
  - no assistant prefill; no temperature / top_p / top_k;
  - strict tool schemas (beta_tool(strict=True): additionalProperties false, all params required);
  - refusal fallback on the beta surface: betas=["server-side-fallback-2026-07-01"],
    fallbacks="default" (both kwargs exist on client.beta.messages.create / parse / tool_runner
    in anthropic 2.3.0);
  - always check stop_reason ("refusal", "max_tokens", "model_context_window_exceeded").
"""

from __future__ import annotations

import logging
from typing import Any

from . import config

log = logging.getLogger(__name__)

TERMINAL_BAD_STOPS = ("refusal", "max_tokens", "model_context_window_exceeded")


class LLMUnavailable(RuntimeError):
    pass


def make_client() -> Any:
    """An anthropic.Anthropic client, or LLMUnavailable when no credentials are configured."""
    if not config.has_llm_credentials():
        raise LLMUnavailable("no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment; use --offline")
    import anthropic

    return anthropic.Anthropic()


def common_kwargs(max_tokens: int | None = None) -> dict:
    """kwargs every beta call carries. Deliberately no thinking / temperature / tool_choice."""
    return {
        "model": config.model(),
        "max_tokens": max_tokens or config.LLM_MAX_TOKENS,
        "output_config": {"effort": config.LLM_EFFORT},
        "betas": list(config.LLM_BETAS),
        "fallbacks": config.LLM_FALLBACKS,
    }


def check_stop(message: Any, what: str) -> str | None:
    """Log and return the stop_reason if it is one we must handle, else None."""
    sr = getattr(message, "stop_reason", None)
    if sr in TERMINAL_BAD_STOPS:
        log.warning("%s: stop_reason=%s", what, sr)
        return sr
    return None


def text_of(message: Any) -> str:
    parts = []
    for block in getattr(message, "content", None) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", ""))
    return "\n".join(parts)
