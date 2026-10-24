"""Thin Claude wrapper with cost logging and an offline fallback.

Set PITWALL_AGENT=claude and ANTHROPIC_API_KEY to use the model. Anything
else (including no key) uses the scripted backend, which returns the given
fallback text. Every result says which backend produced it, so the scorecard
can report exactly what ran.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

DRAFT_MODEL = os.environ.get("PITWALL_DRAFT_MODEL", "claude-haiku-5-5")
REASON_MODEL = os.environ.get("PITWALL_REASON_MODEL", "claude-sonnet-5-5")

SYSTEM = """You are the revenue accountant agent for Meridian Racing, a fictional Formula 1 team.
Rules you never break:
1. You change the books only by proposing entries; a deterministic kernel re-checks everything.
2. Cite policy IDs (REV-xx) and quote source documents exactly. Never paraphrase inside a quote.
3. When sources disagree, name both, pick one using the policy, and say why.
4. If the documents cannot settle a question, ask exactly one question to the right person and say where you already looked.
5. You never approve anything, never write to a closed period, and never bill a provisional result.
Be brief and specific. Plain sentences."""


@dataclass
class LLMResult:
    text: str
    backend: str  # 'claude' | 'scripted'
    model: str | None = None
    cost_cents: float = 0.0


class LLM:
    def __init__(self, store, run_id: str):
        self.store = store
        self.run_id = run_id
        self.enabled = os.environ.get("PITWALL_AGENT", "scripted") == "claude" and bool(os.environ.get("ANTHROPIC_API_KEY"))
        self._client = None
        if self.enabled:
            try:
                import anthropic

                self._client = anthropic.Anthropic()
            except Exception as exc:  # missing SDK: stay scripted, loudly
                print(f"  Claude unavailable ({exc}); using scripted agent")
                self.enabled = False

    def complete(self, prompt: str, *, fallback: str, purpose: str, at: str, model: str = DRAFT_MODEL,
                 max_tokens: int = 400) -> LLMResult:
        if not self.enabled:
            return LLMResult(fallback, "scripted")
        try:
            msg = self._client.messages.create(model=model, max_tokens=max_tokens, system=SYSTEM,
                                               messages=[{"role": "user", "content": prompt}])
            text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
            cost = self.store.log_call(self.run_id, "revenue", model, purpose, msg.usage.input_tokens, msg.usage.output_tokens, at)
            return LLMResult(text or fallback, "claude", model, cost)
        except Exception as exc:
            print(f"  Claude call failed ({exc}); using scripted text")
            return LLMResult(fallback, "scripted")

    def classify(self, prompt: str, options: list[str], *, fallback: str, purpose: str, at: str) -> LLMResult:
        """Ask for exactly one of `options`; falls back to `fallback`."""
        res = self.complete(prompt + f"\n\nAnswer with JSON only: {{\"choice\": one of {json.dumps(options)}, \"why\": \"...\"}}",
                            fallback=json.dumps({"choice": fallback, "why": "scripted"}), purpose=purpose, at=at, model=REASON_MODEL)
        try:
            start = res.text.index("{")
            data = json.loads(res.text[start:res.text.rindex("}") + 1])
            choice = data["choice"] if data.get("choice") in options else fallback
            return LLMResult(choice, res.backend, res.model, res.cost_cents)
        except (ValueError, KeyError):
            return LLMResult(fallback, res.backend, res.model, res.cost_cents)
