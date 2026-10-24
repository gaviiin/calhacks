"""Model-played (here: scripted) people: Dana Okafor (controller), Priya Raman (CFO).

They run only in auto mode (simulations and grading). In the live demo a person
clicks approve/reject in the UI instead, as `dana` or `priya`.
"""

from __future__ import annotations

import json
from pathlib import Path

DANA = "dana"
PRIYA = "priya"


class Personas:
    def __init__(self, world, agent, store):
        self.world = world
        self.agent = agent
        self.store = store
        path = Path(world.dir) / "history" / "controller_rulings.json"
        self.history = json.loads(path.read_text())["rulings"] if path.exists() else {}

    def work(self, ledger) -> list:
        out = []
        for q in ledger.q("SELECT * FROM questions WHERE to_role='controller' AND status='open'"):
            payload = json.loads(q["payload"])
            if payload.get("kind") == "sprint_ambiguity":
                known = self.history.get(payload["rule_hint"])
                answer = known["answer"] if known else "No. Sprints don't count unless the contract says so."
                ledger.answer(q["q_id"], answer)
                out += self.agent.apply_answer(dict(ledger.one("SELECT * FROM questions WHERE q_id=?", q["q_id"])), ledger)
            elif payload.get("kind") == "decision_after_final":
                ledger.answer(q["q_id"], "Noted. I'll apply it in the stewards' panel if it changes the result.")
        for je in ledger.q("SELECT * FROM journal_entries WHERE status='parked'"):
            needs = json.loads(je["needs"])
            done = {r["role"] for r in ledger.q("SELECT role FROM approvals WHERE je_id=? AND decision='approve'", je["je_id"])}
            entry = ledger.entry(je["je_id"])
            if "controller" in needs and "controller" not in done:
                evidence_types = {e["type"] for e in entry["decision"]["evidence"]}
                if je["kind"] == "bonus_reversal" and not ({"fia_document", "stewards_decision"} & evidence_types):
                    out.append(ledger.approve(je["je_id"], DANA, "controller", "reject",
                                              "Show me the stewards' decision before I approve a reversal."))
                    continue
                out.append(ledger.approve(je["je_id"], DANA, "controller", "approve", "Evidence checks out."))
                done.add("controller")
            if "cfo" in needs and "controller" in done and "cfo" not in done:
                out.append(ledger.approve(je["je_id"], PRIYA, "cfo", "approve", "Agree with controller."))
        for rule in self.store.rules():
            if rule["status"] == "draft":
                self.store.approve_rule(rule["rule_id"], rule["version"], DANA, ledger.clock)
                ledger.rules = self.store.approved()
                out.append({"type": "rule_approved", "rule_id": rule["rule_id"], "version": rule["version"]})
        return out
