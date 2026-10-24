"""The revenue agent: judgment the policy book cannot settle on its own.

It only ever (a) proposes entries through the ledger, (b) asks one person one
question, (c) records a decision, or (d) drafts a rule for a person to approve.
"""

from __future__ import annotations

import re

from ..bonuses import Ambiguity
from ..ledger import Decision
from .llm import LLM

AGENT = "agent:revenue"


def parse_ruling(answer: str) -> str:
    """Scripted reading of a controller's answer: 'include' or 'exclude'."""
    low = answer.lower()
    if re.search(r"\b(don'?t|do not|doesn'?t|does not|not|no|exclude|never)\b", low):
        return "exclude"
    if re.search(r"\b(yes|include|count|counts|does)\b", low):
        return "include"
    return "exclude"


class RevenueAgent:
    def __init__(self, world, engine, store, run_id: str):
        self.world = world
        self.engine = engine
        self.store = store
        self.run_id = run_id
        self.llm = LLM(store, run_id)

    def handle(self, unhandled, event: dict, ledger) -> list:
        fn = getattr(self, f"_{unhandled.reason}", None)
        return fn(unhandled.payload, event, ledger) if fn else []

    # ------------------------------------------------------------------ ambiguous clauses (REV-06)

    def _ambiguous_clause(self, payload: dict, event: dict, ledger) -> list:
        a: Ambiguity = payload["ambiguity"]
        subject = a.line.key
        q = ledger.open_question(subject)
        if q and q["status"] == "answered":
            return self.apply_answer(q, ledger)
        if q:
            return []
        past = self.store.rulings(a.rule_hint)
        looked = "Looked at: the contract clause, policy REV-06, and " + (
            f"{len(past)} earlier ruling(s) on this clause" if past else "past controller rulings (none on this clause)")
        draft = self.llm.complete(
            f"Write a two-sentence question to the controller.\nCase: {a.question}\n{looked}.",
            fallback=f"{a.question} {looked}.", purpose="draft_question", at=ledger.clock)
        q_id = ledger.ask("controller", subject, draft.text, AGENT, {
            "kind": "sprint_ambiguity", "rule_hint": a.rule_hint, "sponsor_id": a.sponsor_id, "clause_id": a.clause_id,
            "season": a.season, "round": a.round, "session": a.session, "car": a.car})
        ledger.record_decision(Decision(
            question=a.question, answer="Escalated to the controller: the clause is silent on sprints (REV-06).",
            policy_ids=["REV-06"], outcome="escalate", model=draft.model, cost_cents=int(draft.cost_cents),
            evidence=[{"type": "contract", "ref": f"{a.contract_ref}#{a.clause_id}", "quote": a.line.quote},
                      {"type": "race_result", "ref": f"{a.season}-R{a.round:02d}-{a.session}", "version": "final"}]),
            preparer=AGENT, subject_type="question", subject_id=q_id)
        return [{"type": "question", "q_id": q_id, "subject": subject}]

    def apply_answer(self, q: dict, ledger) -> list:
        import json

        payload = json.loads(q["payload"]) if isinstance(q["payload"], str) else q["payload"]
        if payload.get("kind") != "sprint_ambiguity" or q.get("applied"):
            return []
        ruling = self.llm.classify(
            f"Controller was asked: {q['text']}\nController answered: {q['answer']}\nDoes the clause include sprint races?",
            ["include", "exclude"], fallback=parse_ruling(q["answer"] or ""), purpose="read_answer", at=ledger.clock)
        self.store.add_ruling(q["subject"], payload["rule_hint"], ruling.text, "controller", ledger.clock, self.run_id, q["text"], q["answer"])
        out = []
        season, rnd, session = payload["season"], payload["round"], payload["session"]
        rows = self.world.classification(season, rnd, session, "final", ledger.overlays())
        from ..bonuses import bonuses_for

        _, ambiguities = bonuses_for(self.world, season, rnd, session, rows, ledger.rules)
        line = next((a.line for a in ambiguities if a.line.key == q["subject"]), None)
        if ruling.text == "include" and line is not None and not ledger.active_by_key(line.key):
            out.append(self.engine._propose_bonus(
                line, {"id": q["q_id"], "at": ledger.clock}, ledger, version="final", preparer=AGENT,
                extra_evidence=[{"type": "person", "ref": f"controller answer {q['q_id']}"}],
                decision_note=f"Earned: controller confirmed sprints count for this clause (\"{q['answer']}\")."))
        else:
            ledger.record_decision(Decision(
                question=q["text"], answer=f"Not earned: controller ruled sprints do not count (\"{q['answer']}\").",
                policy_ids=["REV-06"], outcome="not_earned", model=ruling.model,
                evidence=[{"type": "person", "ref": f"controller answer {q['q_id']}"}]),
                preparer=AGENT, subject_type="ruling", subject_id=q["subject"])
        ledger.db.execute("UPDATE questions SET status='applied' WHERE q_id=?", (q["q_id"],))
        ledger.db.commit()
        out += self._maybe_propose_rule(payload["rule_hint"], ledger)
        return out

    def _maybe_propose_rule(self, rule_hint: str, ledger) -> list:
        rulings = self.store.rulings(rule_hint)
        if len(rulings) < 2 or len({r["ruling"] for r in rulings}) != 1:
            return []
        ruling = rulings[0]["ruling"]
        sponsor = rule_hint.split("-")[0].lower()
        text = (f"{self.world.sponsor(sponsor)['name']}: sprint results {'count' if ruling == 'include' else 'do not count'} "
                f"toward the points-finish bonus (from {len(rulings)} controller rulings).")
        version = self.store.propose_rule(rule_hint, text, ruling, [r["subject"] for r in rulings], AGENT, ledger.clock)
        return [{"type": "rule_draft", "rule_id": rule_hint, "version": version, "text": text}]

    # ------------------------------------------------------------------ alerts

    def _at_risk_alert(self, payload: dict, event: dict, ledger) -> list:
        at_risk = [m for m in ledger.memos("expected_bonus", payload["season"], payload["round"]) if m["status"] == "at_risk"]
        held = [b for b in ledger.billings("hold") if b["payload"]["season"] == payload["season"] and b["payload"]["round"] == payload["round"]]
        total = sum(self.world.fx(m["payload"]["currency"], ledger.today) * m["payload"]["amount_orig"] for m in at_risk)
        text = (f"FIA published \"{payload['title']}\" for car {', '.join(map(str, payload['cars']))}. "
                f"{len(at_risk)} expected bonus(es), about ${float(total) / 100:,.0f}, are at risk; nothing has been booked or billed "
                f"(REV-02a). {len(held)} billing request(s) stay on hold until the Final Classification.")
        draft = self.llm.complete(f"Rewrite as a short alert to the controller, keep every number:\n{text}",
                                  fallback=text, purpose="alert", at=ledger.clock)
        ledger.memo("alert", f"alert|{event['id']}", payload["season"], payload["round"], payload.get("session", "race"),
                    {"text": draft.text, "to": "controller", "fia_url": payload.get("url"), "backend": draft.backend})
        return [{"type": "alert", "text": draft.text}]

    def _decision_after_final(self, payload: dict, event: dict, ledger) -> list:
        subject = f"after_final|{payload['season']}|R{payload['round']}|{payload.get('url', '')}"
        if ledger.open_question(subject):
            return []
        q_id = ledger.ask("controller", subject,
                          f"FIA published \"{payload['title']}\" after the Final Classification. If it changes the classification, "
                          "apply it as a stewards' decision and I will reverse the affected bonuses (REV-02a).", AGENT,
                          {"kind": "decision_after_final", **{k: v for k, v in payload.items() if k != "cars"}})
        return [{"type": "question", "q_id": q_id}]
