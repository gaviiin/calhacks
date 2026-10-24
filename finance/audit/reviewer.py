"""Second-opinion reviewer for the auditor: Azure OpenAI, or a rule-based stand-in.

The preparer side of Pit Wall uses Claude. The auditor's reviewer runs on a
different model family (an Azure OpenAI deployment), so one model's blind
spot is less likely to be shared by the check on it.

    AZURE_OPENAI_ENDPOINT     https://<resource>.openai.azure.com
    AZURE_OPENAI_DEPLOYMENT   your deployment name (e.g. gpt-4.1-mini)
    AZURE_OPENAI_API_KEY      or leave empty and use Entra ID (MS_* or managed identity)
    AZURE_OPENAI_API_VERSION  default 2024-10-21

What the reviewer may do: read one entry's decision record, the policy and the
contract clause, and say agree / disagree / unclear with a reason. What it may
not do: change, approve or clear anything. A "disagree" becomes a low-severity
finding for a person to read; an "agree" changes nothing.
"""

from __future__ import annotations

import json
import os
import time

from ..money import fmt

SYSTEM = """You are an independent financial auditor reviewing revenue entries for Meridian Racing, a fictional Formula 1 team.
You did not prepare these entries. Your job is to find reasons they could be wrong.
For each entry you get the preparer's question, answer, cited policies and evidence, the relevant policy text and contract clause.
Judge only from what you are given. Respond with JSON only:
{"verdict": "agree" | "disagree" | "unclear", "concern": "<one or two sentences; empty if agree>", "policy_ids": ["REV-.."]}
Disagree only when the record itself shows a problem (wrong policy, unsupported conclusion, missing evidence, a quote that does not say what is claimed)."""

MEMO_SYSTEM = """You are an audit manager writing the summary memo of an automated revenue audit for a CFO.
Plain sentences, no marketing. State the opinion, what was tested, the findings that matter and what to do next.
Never invent findings or numbers; use only the JSON you are given. At most 180 words."""


class Reviewer:
    """Rule-based reviewer used when no Azure OpenAI deployment is configured."""

    backend = "rules"

    def describe(self) -> dict:
        return {"backend": self.backend}

    def review_entries(self, items: list[tuple[dict, str]], world) -> list[dict]:
        out = []
        for e, why in items:
            d = e.get("decision") or {}
            concern = ""
            if not d.get("evidence"):
                concern = "The decision cites no evidence."
            elif e["kind"] in ("bonus_reversal", "prize_estimate_change") and not e["approvals"]:
                concern = "A judgment entry posted without a person's approval."
            out.append({"je_id": e["je_id"], "why_sampled": why, "verdict": "disagree" if concern else "agree", "concern": concern,
                        "backend": self.backend})
        return out

    def memo(self, report: dict) -> str:
        from .auditor import default_memo

        return default_memo(report)


class AzureOpenAIReviewer(Reviewer):
    backend = "azure_openai"

    def __init__(self, env=os.environ, client=None, store=None, run_id: str = ""):
        self.env = env
        self.deployment = env["AZURE_OPENAI_DEPLOYMENT"]
        self.store, self.run_id = store, run_id
        self.calls = 0
        self.tokens = {"input": 0, "output": 0}
        self.errors: list[str] = []
        self.reasoning = env.get("AZURE_OPENAI_REASONING", "0") == "1"
        self.client = client or self._client()

    def _client(self):
        from openai import AzureOpenAI

        kw = {"azure_endpoint": self.env["AZURE_OPENAI_ENDPOINT"], "api_version": self.env.get("AZURE_OPENAI_API_VERSION", "2024-10-21")}
        if self.env.get("AZURE_OPENAI_API_KEY"):
            kw["api_key"] = self.env["AZURE_OPENAI_API_KEY"]
        else:  # Entra ID: no key anywhere
            from ..microsoft.auth import token

            kw["azure_ad_token_provider"] = lambda: token("https://cognitiveservices.azure.com/.default", self.env)
        return AzureOpenAI(**kw)

    def describe(self) -> dict:
        return {"backend": self.backend, "deployment": self.deployment, "calls": self.calls, "tokens": self.tokens,
                "errors": self.errors[-3:]}

    def _chat(self, system: str, user: str, as_json: bool, max_tokens: int = 300) -> str | None:
        kw = {"response_format": {"type": "json_object"}} if as_json else {}
        for attempt in range(3):
            # Reasoning deployments (o-series, gpt-5) take max_completion_tokens and no temperature.
            sizing = ({"max_completion_tokens": max_tokens * 8} if self.reasoning else {"max_tokens": max_tokens, "temperature": 0})
            try:
                r = self.client.chat.completions.create(model=self.deployment, **sizing, **kw,
                                                        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
                self.calls += 1
                if r.usage:
                    self.tokens["input"] += r.usage.prompt_tokens
                    self.tokens["output"] += r.usage.completion_tokens
                    if self.store is not None:
                        self.store.log_call(self.run_id, "auditor", f"azure:{self.deployment}", "audit_review",
                                            r.usage.prompt_tokens, r.usage.completion_tokens, "audit")
                return r.choices[0].message.content
            except Exception as exc:  # content filter, throttling, network: fall back, never fail the audit
                self.errors.append(f"{type(exc).__name__}: {exc}"[:200])
                if not self.reasoning and ("max_tokens" in str(exc) or "temperature" in str(exc)):
                    self.reasoning = True
                    continue
                if "429" in str(exc) and attempt < 2:
                    time.sleep(2)
                    continue
                return None
        return None

    def review_entries(self, items: list[tuple[dict, str]], world) -> list[dict]:
        rules = Reviewer.review_entries(self, items, world)
        policy = world.policy_text()[:6000]
        out = []
        for (e, why), fallback in zip(items, rules):
            d = e.get("decision") or {}
            clause = ""
            for ev in d.get("evidence", []):
                if ev.get("type") == "contract":
                    try:
                        clause = world.contract_text(ev["ref"].split("#")[0])[:2500]
                    except (KeyError, FileNotFoundError):
                        pass
            record = {"je_id": e["je_id"], "kind": e["kind"], "amount": fmt(e["total_cents"] or 0), "memo": e["memo"],
                      "preparer": e["preparer"], "question": d.get("question"), "answer": d.get("answer"),
                      "policy_ids": d.get("policy_ids"), "evidence": d.get("evidence"),
                      "approvals": [{k: a[k] for k in ("approver", "role", "decision")} for a in e["approvals"]],
                      "lines": [{k: x[k] for k in ("account", "debit_cents", "credit_cents", "orig_currency", "orig_amount_cents", "fx_rate")}
                                for x in e["lines"]]}
            text = self._chat(SYSTEM, f"POLICY:\n{policy}\n\nCONTRACT:\n{clause or '(none cited)'}\n\nENTRY:\n{json.dumps(record, default=str)}",
                              as_json=True)
            try:
                data = json.loads(text) if text else None
                verdict = data["verdict"] if data and data.get("verdict") in ("agree", "disagree", "unclear") else None
            except (ValueError, KeyError, TypeError):
                verdict, data = None, None
            if verdict is None:
                out.append({**fallback, "note": "model unavailable; rule-based result"})
            else:
                out.append({"je_id": e["je_id"], "why_sampled": why, "verdict": verdict, "concern": data.get("concern", ""),
                            "policy_ids": data.get("policy_ids", []), "backend": self.backend, "deployment": self.deployment})
        return out

    def memo(self, report: dict) -> str:
        slim = {k: report[k] for k in ("season", "as_of", "opinion", "summary", "coverage")}
        slim["findings"] = [{k: f[k] for k in ("severity", "procedure", "title", "detail", "amount_cents", "recommendation")}
                            for f in report["findings"][:10]]
        text = self._chat(MEMO_SYSTEM, json.dumps(slim, default=str), as_json=False, max_tokens=400)
        return text.strip() if text else Reviewer.memo(self, report)


def make_reviewer(env=os.environ, store=None, run_id: str = "") -> Reviewer:
    if env.get("PITWALL_AUDITOR", "auto") != "rules" and env.get("AZURE_OPENAI_ENDPOINT") and env.get("AZURE_OPENAI_DEPLOYMENT"):
        try:
            return AzureOpenAIReviewer(env, store=store, run_id=run_id)
        except Exception as exc:  # missing SDK or bad config: say so, keep auditing
            print(f"  Azure OpenAI reviewer unavailable ({exc}); using rule-based reviewer")
    return Reviewer()
