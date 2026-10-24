"""Agent memory that outlives a run: controller rulings, learned rules, model-call costs.

Kept in its own SQLite file (data/agents.db) so a rule the controller approved
during the training season applies, in code, to the test season.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ..config import DATA_DIR

SCHEMA = """
CREATE TABLE IF NOT EXISTS rulings (subject TEXT, rule_hint TEXT, ruling TEXT, by TEXT, at TEXT, run_id TEXT, question TEXT, answer TEXT);
CREATE TABLE IF NOT EXISTS rules (rule_id TEXT, version INTEGER, text TEXT, ruling TEXT, status TEXT, precedents TEXT,
  proposed_by TEXT, proposed_at TEXT, approved_by TEXT, approved_at TEXT, PRIMARY KEY (rule_id, version));
CREATE TABLE IF NOT EXISTS calls (run_id TEXT, agent TEXT, model TEXT, purpose TEXT, input_tokens INTEGER,
  output_tokens INTEGER, cost_cents REAL, at TEXT);
"""

# USD per million tokens (input, output). Used only for the cost panel; adjust to the live price list.
PRICES = {"claude-haiku-5-5": (1.0, 5.0), "claude-sonnet-5-5": (3.0, 15.0), "claude-opus-5-5": (5.0, 25.0)}


class AgentStore:
    def __init__(self, path: Path | str = DATA_DIR / "agents.db"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def add_ruling(self, subject: str, rule_hint: str, ruling: str, by: str, at: str, run_id: str, question: str, answer: str) -> None:
        self.db.execute("INSERT INTO rulings VALUES (?,?,?,?,?,?,?,?)", (subject, rule_hint, ruling, by, at, run_id, question, answer))
        self.db.commit()

    def rulings(self, rule_hint: str) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT * FROM rulings WHERE rule_hint=? ORDER BY at", (rule_hint,))]

    def propose_rule(self, rule_id: str, text: str, ruling: str, precedents: list[str], by: str, at: str) -> int:
        row = self.db.execute("SELECT MAX(version) v FROM rules WHERE rule_id=?", (rule_id,)).fetchone()
        current = self.rule(rule_id)
        if current and current["ruling"] == ruling and current["status"] in ("draft", "approved"):
            return current["version"]
        version = (row["v"] or 0) + 1
        self.db.execute("INSERT INTO rules VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (rule_id, version, text, ruling, "draft", json.dumps(precedents), by, at, None, None))
        self.db.commit()
        return version

    def approve_rule(self, rule_id: str, version: int, by: str, at: str) -> None:
        if by.startswith("agent:") or by == "code":
            raise PermissionError("rules are approved by a person")
        self.db.execute("UPDATE rules SET status='retired' WHERE rule_id=? AND status='approved'", (rule_id,))
        self.db.execute("UPDATE rules SET status='approved', approved_by=?, approved_at=? WHERE rule_id=? AND version=?",
                        (by, at, rule_id, version))
        self.db.commit()

    def rule(self, rule_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM rules WHERE rule_id=? AND status IN ('draft','approved') ORDER BY version DESC LIMIT 1",
                              (rule_id,)).fetchone()
        return {**dict(row), "precedents": json.loads(row["precedents"])} if row else None

    def rules(self) -> list[dict]:
        return [{**dict(r), "precedents": json.loads(r["precedents"])} for r in self.db.execute("SELECT * FROM rules ORDER BY rule_id, version")]

    def approved(self) -> dict[str, str]:
        return {r["rule_id"]: r["ruling"] for r in self.db.execute("SELECT rule_id, ruling FROM rules WHERE status='approved'")}

    def log_call(self, run_id: str, agent: str, model: str, purpose: str, tin: int, tout: int, at: str) -> float:
        pin, pout = PRICES.get(model, (3.0, 15.0))
        cents = (tin * pin + tout * pout) / 1_000_000 * 100
        self.db.execute("INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)", (run_id, agent, model, purpose, tin, tout, cents, at))
        self.db.commit()
        return cents

    def costs(self, run_id: str) -> dict:
        row = self.db.execute("SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, "
                              "COALESCE(SUM(cost_cents),0) c FROM calls WHERE run_id=?", (run_id,)).fetchone()
        return {"model_calls": row["n"], "input_tokens": row["i"], "output_tokens": row["o"], "cost_cents": round(row["c"], 2)}

    def reset(self) -> None:
        self.db.executescript("DELETE FROM rulings; DELETE FROM rules; DELETE FROM calls;")
        self.db.commit()
