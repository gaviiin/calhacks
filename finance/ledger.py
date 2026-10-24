"""The ledger: one SQLite file per run, one write path.

`propose_entry` is the only way anything reaches the books. It runs every
kernel check, records the decision behind the proposal whatever the outcome,
and then posts, parks for a person, or refuses. `approve` is the only way a
parked entry posts, and it enforces segregation of duties (K11).

Entries are bitemporal: `effective_date` is when it happened in the world,
`recorded_at` is when the system booked it (the simulation clock), which is
what as-of replay and what-moved read.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import ACCOUNTS

SCHEMA = """
CREATE TABLE IF NOT EXISTS journal_entries (
  je_id TEXT PRIMARY KEY, kind TEXT, period_id TEXT, effective_date TEXT, recorded_at TEXT, posted_at TEXT,
  status TEXT, preparer TEXT, needs TEXT, memo TEXT, key TEXT, reverses_je_id TEXT, reversed_by TEXT,
  source_event_id TEXT, decision_id TEXT, sponsor_id TEXT, total_cents INTEGER, basis TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS je_lines (
  je_id TEXT, line_no INTEGER, account TEXT, debit_cents INTEGER, credit_cents INTEGER,
  orig_currency TEXT, orig_amount_cents INTEGER, fx_rate TEXT, sponsor_id TEXT, carrying INTEGER);
CREATE TABLE IF NOT EXISTS checks (je_id TEXT, check_id TEXT, result TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY, je_id TEXT, subject_type TEXT, subject_id TEXT, question TEXT, answer TEXT,
  outcome TEXT, policy_ids TEXT, evidence TEXT, rule_id TEXT, preparer TEXT, model TEXT, cost_cents INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT, je_id TEXT, approver TEXT, role TEXT, decision TEXT, reason TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS periods (period_id TEXT PRIMARY KEY, status TEXT, closed_at TEXT);
CREATE TABLE IF NOT EXISTS finals (season INTEGER, round INTEGER, session TEXT, finalized_at TEXT, source TEXT,
  PRIMARY KEY (season, round, session));
CREATE TABLE IF NOT EXISTS overlays (overlay_id TEXT PRIMARY KEY, payload TEXT, applied_at TEXT);
CREATE TABLE IF NOT EXISTS prize_estimates (season INTEGER, through_round INTEGER, position INTEGER, est_cents INTEGER,
  why TEXT, recorded_at TEXT);
CREATE TABLE IF NOT EXISTS memos (memo_id TEXT PRIMARY KEY, kind TEXT, key TEXT, season INTEGER, round INTEGER,
  session TEXT, payload TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS billing (request_id TEXT PRIMARY KEY, payload TEXT, status TEXT, reason_code TEXT,
  history TEXT, je_id TEXT, decided_at TEXT);
CREATE TABLE IF NOT EXISTS questions (q_id TEXT PRIMARY KEY, to_role TEXT, subject TEXT, text TEXT, status TEXT,
  answer TEXT, asked_at TEXT, answered_at TEXT, asked_by TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, type TEXT, at TEXT,
  payload TEXT, results TEXT);
"""


@dataclass
class Line:
    account: str
    debit: int = 0
    credit: int = 0
    currency: str = "USD"
    orig: int | None = None  # amount in original currency cents, for receivables and FX lines
    rate: str | None = None
    sponsor_id: str | None = None
    carrying: bool = False  # True when the USD amount is a historical carrying amount (no rate check)


@dataclass
class Decision:
    question: str
    answer: str
    policy_ids: list[str]
    evidence: list[dict] = field(default_factory=list)
    outcome: str | None = None
    rule_id: str | None = None
    model: str | None = None
    cost_cents: int = 0


@dataclass
class Proposal:
    kind: str
    effective_date: str  # YYYY-MM-DD
    memo: str
    lines: list[Line]
    decision: Decision
    preparer: str  # 'code' | 'agent:<name>' | 'saboteur'
    source_event_id: str = ""
    key: str | None = None
    reverses_je_id: str | None = None
    sponsor_id: str | None = None
    basis: dict = field(default_factory=dict)


@dataclass
class Result:
    status: str  # posted | parked | refused
    je_id: str
    checks: list[dict]
    reason: str | None = None
    needs: list[str] = field(default_factory=list)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Ledger:
    def __init__(self, path: Path | str, world, kernel=None):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.world = world
        from .kernel import Kernel

        self.kernel = kernel or Kernel(world)
        self.clock = "1970-01-01T00:00:00Z"
        self.rules: dict[str, str] = {}
        self.listeners: list = []  # callables(event_name, payload) for live mirrors

    # ------------------------------------------------------------------ helpers

    def q(self, sql: str, *args) -> list[sqlite3.Row]:
        return self.db.execute(sql, args).fetchall()

    def one(self, sql: str, *args):
        return self.db.execute(sql, args).fetchone()

    def emit(self, name: str, payload: dict) -> None:
        for fn in self.listeners:
            try:
                fn(name, payload)
            except Exception as exc:  # a mirror must never break the books
                print(f"  mirror error ({name}): {exc}")

    @property
    def today(self) -> str:
        return self.clock[:10]

    # ------------------------------------------------------------------ periods

    def period_status(self, period_id: str) -> str:
        row = self.one("SELECT status FROM periods WHERE period_id=?", period_id)
        return row["status"] if row else "open"

    def close_period(self, period_id: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO periods VALUES (?,?,?)", (period_id, "closed", self.clock))
        self.db.commit()
        self.emit("period_closed", {"period_id": period_id, "at": self.clock})

    def posting_date(self, effective_date: str) -> str:
        """The effective date, or today's date when that month is already closed (REV-08)."""
        return effective_date if self.period_status(effective_date[:7]) == "open" else self.today

    # ------------------------------------------------------------------ write path

    def record_decision(self, d: Decision, *, preparer: str, je_id: str | None = None,
                        subject_type: str = "entry", subject_id: str = "") -> str:
        decision_id = new_id("dec")
        self.db.execute(
            "INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (decision_id, je_id, subject_type, subject_id, d.question, d.answer, d.outcome,
             json.dumps(d.policy_ids), json.dumps(d.evidence), d.rule_id, preparer, d.model, d.cost_cents, self.clock),
        )
        self.db.commit()
        return decision_id

    def propose_entry(self, p: Proposal) -> Result:
        je_id = new_id("je")
        checks = self.kernel.check(p, self)
        failed = [c for c in checks if c["result"] == "fail"]
        parks = [c for c in checks if c["result"] == "park"]
        needs = sorted({n for c in parks for n in c.get("needs", [])}, key=["controller", "cfo"].index)
        status = "refused" if failed else "parked" if parks else "posted"
        reason = failed[0]["reason"] if failed else (parks[0]["reason"] if parks else None)
        total = sum(line.debit for line in p.lines)
        decision_id = self.record_decision(p.decision, preparer=p.preparer, je_id=je_id, subject_id=je_id)
        self.db.execute(
            "INSERT INTO journal_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (je_id, p.kind, p.effective_date[:7], p.effective_date, self.clock,
             self.clock if status == "posted" else None, status, p.preparer, json.dumps(needs), p.memo, p.key,
             p.reverses_je_id, None, p.source_event_id, decision_id, p.sponsor_id, total, json.dumps(p.basis), reason),
        )
        for i, line in enumerate(p.lines):
            self.db.execute(
                "INSERT INTO je_lines VALUES (?,?,?,?,?,?,?,?,?,?)",
                (je_id, i, line.account, line.debit, line.credit, line.currency, line.orig, line.rate,
                 line.sponsor_id, int(line.carrying)),
            )
        for c in checks:
            self.db.execute("INSERT INTO checks VALUES (?,?,?,?)", (je_id, c["id"], c["result"], c.get("reason")))
        if status == "posted" and p.reverses_je_id:
            self.db.execute("UPDATE journal_entries SET reversed_by=? WHERE je_id=?", (je_id, p.reverses_je_id))
        self.db.commit()
        result = Result(status, je_id, checks, reason, needs)
        self.emit("entry", self.entry(je_id))
        return result

    def approve(self, je_id: str, approver: str, role: str, decision: str = "approve", reason: str = "") -> Result:
        je = self.one("SELECT * FROM journal_entries WHERE je_id=?", je_id)
        if je is None:
            raise KeyError(je_id)
        check = self.kernel.check_approval(je, approver, role, self)
        if check["result"] == "fail":
            return Result("refused", je_id, [check], check["reason"], json.loads(je["needs"]))
        if je["status"] != "parked":
            return Result(je["status"], je_id, [], f"entry is {je['status']}, not parked")
        self.db.execute("INSERT INTO approvals VALUES (?,?,?,?,?,?,?)",
                        (new_id("apr"), je_id, approver, role, decision, reason, self.clock))
        if decision == "reject":
            self.db.execute("UPDATE journal_entries SET status='rejected', reason=? WHERE je_id=?",
                            (f"rejected by {approver} ({role}): {reason}", je_id))
            self.db.commit()
            self.emit("entry", self.entry(je_id))
            return Result("rejected", je_id, [check], reason)
        needs = json.loads(je["needs"])
        approved_roles = {r["role"] for r in self.q("SELECT role FROM approvals WHERE je_id=? AND decision='approve'", je_id)}
        if all(n in approved_roles for n in needs):
            # Re-check at the post gate: the world may have moved since the entry parked.
            recheck = self.kernel.check_at_post(je, self)
            if recheck:
                self.db.execute("UPDATE journal_entries SET status='refused', reason=? WHERE je_id=?", (recheck, je_id))
                self.db.commit()
                self.emit("entry", self.entry(je_id))
                return Result("refused", je_id, [], recheck)
            self.db.execute("UPDATE journal_entries SET status='posted', posted_at=? WHERE je_id=?", (self.clock, je_id))
            if je["reverses_je_id"]:
                self.db.execute("UPDATE journal_entries SET reversed_by=? WHERE je_id=?", (je_id, je["reverses_je_id"]))
            self.db.commit()
            self.emit("entry", self.entry(je_id))
            return Result("posted", je_id, [check])
        self.db.commit()
        return Result("parked", je_id, [check], None, [n for n in needs if n not in approved_roles])

    # ------------------------------------------------------------------ world state kept by the ledger

    def mark_final(self, season: int, rnd: int, session: str, source: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO finals VALUES (?,?,?,?,?)", (season, rnd, session, self.clock, source))
        self.db.commit()

    def is_final(self, season: int, rnd: int, session: str) -> bool:
        return self.one("SELECT 1 FROM finals WHERE season=? AND round=? AND session=?", season, rnd, session) is not None

    def finals_count(self, season: int, session: str = "race") -> int:
        return self.one("SELECT COUNT(*) n FROM finals WHERE season=? AND session=?", season, session)["n"]

    def last_final_round(self, season: int) -> int:
        row = self.one("SELECT MAX(round) r FROM finals WHERE season=? AND session='race'", season)
        return row["r"] or 0

    def add_overlay(self, payload: dict) -> str:
        overlay_id = payload.get("overlay_id") or new_id("ovl")
        self.db.execute("INSERT INTO overlays VALUES (?,?,?)", (overlay_id, json.dumps({**payload, "overlay_id": overlay_id}), self.clock))
        self.db.commit()
        return overlay_id

    def overlays(self) -> list[dict]:
        return [json.loads(r["payload"]) for r in self.q("SELECT payload FROM overlays ORDER BY applied_at")]

    def record_prize_estimate(self, season: int, through_round: int, position: int, est: int, why: str) -> None:
        self.db.execute("INSERT INTO prize_estimates VALUES (?,?,?,?,?,?)", (season, through_round, position, est, why, self.clock))
        self.db.commit()

    def last_prize_estimate(self, season: int) -> dict | None:
        row = self.one("SELECT * FROM prize_estimates WHERE season=? ORDER BY rowid DESC LIMIT 1", season)
        return dict(row) if row else None

    # ------------------------------------------------------------------ memos and questions

    def memo(self, kind: str, key: str, season: int, rnd: int, session: str, payload: dict, status: str = "open") -> str:
        existing = self.one("SELECT memo_id FROM memos WHERE kind=? AND key=?", kind, key)
        if existing:
            self.db.execute("UPDATE memos SET payload=?, status=?, updated_at=? WHERE memo_id=?",
                            (json.dumps(payload), status, self.clock, existing["memo_id"]))
            memo_id = existing["memo_id"]
        else:
            memo_id = new_id("memo")
            self.db.execute("INSERT INTO memos VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (memo_id, kind, key, season, rnd, session, json.dumps(payload), status, self.clock, self.clock))
        self.db.commit()
        self.emit("memo", {"memo_id": memo_id, "kind": kind, "key": key, "status": status, **payload})
        return memo_id

    def memos(self, kind: str | None = None, season: int | None = None, rnd: int | None = None) -> list[dict]:
        sql, args = "SELECT * FROM memos WHERE 1=1", []
        for col, val in (("kind", kind), ("season", season), ("round", rnd)):
            if val is not None:
                sql += f" AND {col}=?"
                args.append(val)
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in self.q(sql, *args)]

    def ask(self, to_role: str, subject: str, text: str, asked_by: str, payload: dict) -> str:
        q_id = new_id("q")
        self.db.execute("INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (q_id, to_role, subject, text, "open", None, self.clock, None, asked_by, json.dumps(payload)))
        self.db.commit()
        self.emit("question", {"q_id": q_id, "to_role": to_role, "subject": subject, "text": text, "status": "open"})
        return q_id

    def answer(self, q_id: str, answer: str) -> None:
        self.db.execute("UPDATE questions SET status='answered', answer=?, answered_at=? WHERE q_id=?", (answer, self.clock, q_id))
        self.db.commit()
        self.emit("question", {"q_id": q_id, "status": "answered", "answer": answer})

    def open_question(self, subject: str) -> dict | None:
        row = self.one("SELECT * FROM questions WHERE subject=? ORDER BY asked_at DESC LIMIT 1", subject)
        return dict(row) if row else None

    # ------------------------------------------------------------------ billing requests

    def billing(self, request_id: str) -> dict | None:
        row = self.one("SELECT * FROM billing WHERE request_id=?", request_id)
        if not row:
            return None
        return {**dict(row), "payload": json.loads(row["payload"]), "history": json.loads(row["history"])}

    def set_billing(self, request: dict, status: str, reason_code: str, je_id: str | None = None) -> None:
        current = self.billing(request["request_id"])
        history = (current["history"] if current else []) + [{"at": self.clock, "status": status, "reason": reason_code}]
        self.db.execute(
            "INSERT OR REPLACE INTO billing VALUES (?,?,?,?,?,?,?)",
            (request["request_id"], json.dumps(request), status, reason_code, json.dumps(history),
             je_id or (current["je_id"] if current else None), self.clock),
        )
        self.db.commit()
        self.emit("billing", {"request_id": request["request_id"], "status": status, "reason": reason_code})

    def billings(self, status: str | None = None) -> list[dict]:
        rows = self.q("SELECT * FROM billing" + (" WHERE status=?" if status else ""), *([status] if status else []))
        return [{**dict(r), "payload": json.loads(r["payload"]), "history": json.loads(r["history"])} for r in rows]

    # ------------------------------------------------------------------ reads

    def entry(self, je_id: str) -> dict:
        je = self.one("SELECT * FROM journal_entries WHERE je_id=?", je_id)
        if je is None:
            raise KeyError(je_id)
        out = dict(je)
        out["needs"] = json.loads(je["needs"] or "[]")
        out["basis"] = json.loads(je["basis"] or "{}")
        out["lines"] = [dict(r) for r in self.q("SELECT * FROM je_lines WHERE je_id=? ORDER BY line_no", je_id)]
        out["checks"] = [dict(r) for r in self.q("SELECT check_id, result, reason FROM checks WHERE je_id=?", je_id)]
        out["approvals"] = [dict(r) for r in self.q("SELECT approver, role, decision, reason, at FROM approvals WHERE je_id=?", je_id)]
        d = self.one("SELECT * FROM decisions WHERE decision_id=?", je["decision_id"])
        out["decision"] = {**dict(d), "policy_ids": json.loads(d["policy_ids"]), "evidence": json.loads(d["evidence"])} if d else None
        return out

    def entries(self, kind: str | None = None, status: str | None = None, as_of: str | None = None) -> list[dict]:
        sql, args = "SELECT je_id FROM journal_entries WHERE 1=1", []
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        if status:
            sql += " AND status=?"
            args.append(status)
        if as_of:
            sql += " AND recorded_at<=?"
            args.append(as_of)
        return [self.entry(r["je_id"]) for r in self.q(sql + " ORDER BY recorded_at, rowid", *args)]

    def active_by_key(self, key: str) -> dict | None:
        """The posted or parked entry for a key that has not been reversed."""
        row = self.one(
            "SELECT je_id FROM journal_entries WHERE key=? AND status IN ('posted','parked') AND reversed_by IS NULL "
            "ORDER BY rowid DESC LIMIT 1", key)
        return self.entry(row["je_id"]) if row else None

    def active_bonuses(self, season: int, rnd: int, session: str) -> list[dict]:
        prefix = f"bonus|{season}|R{rnd}|{session}|"
        rows = self.q(
            "SELECT je_id FROM journal_entries WHERE kind='bonus' AND key LIKE ? AND status IN ('posted','parked') "
            "AND reversed_by IS NULL AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_je_id=journal_entries.je_id "
            "AND r.status IN ('posted','parked'))", prefix + "%")
        return [self.entry(r["je_id"]) for r in rows]

    def pending_reversal(self, je_id: str) -> dict | None:
        row = self.one("SELECT je_id FROM journal_entries WHERE reverses_je_id=? AND status IN ('posted','parked')", je_id)
        return self.entry(row["je_id"]) if row else None

    def balances(self, as_of: str | None = None, by_sponsor: bool = False) -> dict:
        sql = ("SELECT l.account, l.sponsor_id, SUM(l.debit_cents) d, SUM(l.credit_cents) c, SUM(CASE WHEN l.debit_cents>0 "
               "THEN COALESCE(l.orig_amount_cents,0) ELSE -COALESCE(l.orig_amount_cents,0) END) o FROM je_lines l "
               "JOIN journal_entries j ON j.je_id=l.je_id WHERE j.status='posted'")
        args = []
        if as_of:
            sql += " AND j.posted_at<=?"
            args.append(as_of)
        sql += " GROUP BY l.account" + (", l.sponsor_id" if by_sponsor else "")
        out = {}
        for r in self.q(sql, *args):
            k = (r["account"], r["sponsor_id"]) if by_sponsor else r["account"]
            out[k] = {"debit": r["d"] or 0, "credit": r["c"] or 0, "net": (r["d"] or 0) - (r["c"] or 0), "orig_net": r["o"] or 0}
        return out

    def trial_balance(self, as_of: str | None = None) -> dict:
        b = self.balances(as_of)
        rows = [{"account": a, "name": ACCOUNTS.get(a, a), **v} for a, v in sorted(b.items())]
        dr = sum(v["debit"] for v in b.values())
        cr = sum(v["credit"] for v in b.values())
        return {"rows": rows, "debits": dr, "credits": cr, "ties": dr == cr}

    def ar(self, sponsor_id: str) -> tuple[int, int]:
        """(USD carrying, original-currency balance) of a sponsor's receivable."""
        b = self.balances(by_sponsor=True).get(("1200", sponsor_id))
        return (b["net"], b["orig_net"]) if b else (0, 0)

    def prize_booked(self, season: int) -> int:
        row = self.one(
            "SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0) n FROM je_lines l JOIN journal_entries j ON j.je_id=l.je_id "
            "WHERE j.status IN ('posted','parked') AND l.account='4100' AND j.key LIKE ?", f"prize|{season}|%")
        return row["n"]

    def log_event(self, event: dict, results: list) -> None:
        self.db.execute("INSERT INTO events (event_id,type,at,payload,results) VALUES (?,?,?,?,?)",
                        (event["id"], event["type"], event["at"], json.dumps(event.get("payload", {})),
                         json.dumps([asdict(r) if hasattr(r, "__dataclass_fields__") else r for r in results], default=str)))
        self.db.commit()
        acted = any(getattr(r, "status", None) in ("posted", "parked") or (isinstance(r, dict) and r.get("type") in ("alert", "question"))
                    for r in results)
        self.emit("event", {"id": event["id"], "type": event["type"], "at": event["at"], "payload": event.get("payload", {}), "acted": acted})
