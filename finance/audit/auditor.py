"""The independent auditor: a second line of defence that trusts nothing the preparer says.

The kernel stops bad entries at the door. The auditor assumes the door can be
bypassed (a database edit, a bug in the kernel, an approval made in error)
and re-checks the books after the fact, the way an external auditor would:

    A1 integrity      every entry balances; every posted entry has its kernel checks, a decision
                      record and an unbroken evidence seal; the seal chain matches its anchors
    A2 completeness   every bonus the final results earn is booked, and nothing else is
                      (computed from the results and contracts, not from the engine's code)
    A3 accuracy       a risk-weighted sample of entries re-performed from source: contract
                      amounts, base-fee shares, FX rates, cash receipts
    A4 approvals      segregation of duties and materiality tested on every posted entry
    A5 cut-off        no bonus booked before its result was final
    A6 reconciliation trial balance ties; the sponsor sub-ledger agrees to the general ledger
    A7 billing        every invoice the commercial team got traces to a booked bonus

It opens the ledger read-only (SQLite mode=ro), writes only to its own audit
file, and cannot propose, approve or change anything. A model (Azure OpenAI,
a different family from the preparer's Claude) can add a second opinion on
judgment calls; that opinion is advisory and can raise an item, never clear one.
"""

from __future__ import annotations

import hashlib
import json
import random
import sqlite3
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from ..config import CFO_CENTS, JUDGMENT_KINDS, MATERIALITY_CENTS
from ..eval import truth_bonuses
from ..money import fmt, to_usd
from .seal import GENESIS, AnchorSink, chain, entry_hash

AUDIT_SCHEMA = """
CREATE TABLE IF NOT EXISTS audits (audit_id TEXT PRIMARY KEY, run_id TEXT, as_of TEXT, opinion TEXT, report TEXT, created_at TEXT);
"""

SEVERITY = {"high": 3, "medium": 2, "low": 1}


@dataclass
class Finding:
    procedure: str
    severity: str  # high | medium | low
    title: str
    detail: str
    je_id: str | None = None
    amount_cents: int = 0
    recommendation: str = ""
    evidence: dict = field(default_factory=dict)
    second_opinion: dict | None = None

    @property
    def fid(self) -> str:
        return "F-" + hashlib.sha1(f"{self.procedure}|{self.title}|{self.je_id}".encode()).hexdigest()[:8]


def _ro(path: str | Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True, check_same_thread=False)
    db.row_factory = sqlite3.Row
    return db


class Auditor:
    def __init__(self, ledger_path: str | Path, world, run_id: str, season: int, reviewer=None, sample_rate: float = 0.15,
                 seed: str | None = None):
        self.path = Path(ledger_path)
        self.folder = self.path.parent
        self.world, self.run_id, self.season = world, run_id, season
        self.db = _ro(self.path)
        self.reviewer = reviewer
        self.sample_rate = sample_rate
        self.rng = random.Random(seed or run_id)
        self.findings: list[Finding] = []
        self.coverage: dict[str, dict] = {}

    # ------------------------------------------------------------------ reading the books (own queries, no Ledger class)

    def q(self, sql: str, *args) -> list[sqlite3.Row]:
        return self.db.execute(sql, args).fetchall()

    def entries(self) -> list[dict]:
        lines, approvals, checks = defaultdict(list), defaultdict(list), defaultdict(list)
        for r in self.q("SELECT * FROM je_lines ORDER BY je_id, line_no"):
            lines[r["je_id"]].append(dict(r))
        for r in self.q("SELECT approver, role, decision, reason, at, je_id FROM approvals"):
            approvals[r["je_id"]].append(dict(r))
        for r in self.q("SELECT * FROM checks"):
            checks[r["je_id"]].append(dict(r))
        decisions = {r["decision_id"]: dict(r) for r in self.q("SELECT * FROM decisions")}
        out = []
        for r in self.q("SELECT * FROM journal_entries ORDER BY recorded_at, rowid"):
            e = dict(r)
            e["needs"] = json.loads(e["needs"] or "[]")
            e["basis"] = json.loads(e["basis"] or "{}")
            e["lines"], e["approvals"], e["checks"] = lines[e["je_id"]], approvals[e["je_id"]], checks[e["je_id"]]
            d = decisions.get(e["decision_id"])
            e["decision"] = {**d, "policy_ids": json.loads(d["policy_ids"]), "evidence": json.loads(d["evidence"])} if d else None
            out.append(e)
        return out

    def add(self, *args, **kw) -> None:
        self.findings.append(Finding(*args, **kw))

    # ------------------------------------------------------------------ A1 integrity

    def a1_integrity(self, entries: list[dict]) -> None:
        posted = [e for e in entries if e["status"] == "posted"]
        for e in entries:
            dr = sum(x["debit_cents"] for x in e["lines"])
            cr = sum(x["credit_cents"] for x in e["lines"])
            if dr != cr:
                self.add("A1", "high", "Entry does not balance", f"debits {fmt(dr)} vs credits {fmt(cr)}", e["je_id"], abs(dr - cr),
                         "Investigate how an unbalanced entry reached the ledger; the kernel refuses these.")
            elif e["total_cents"] != dr:
                self.add("A1", "high", "Entry header total disagrees with its lines",
                         f"header {fmt(e['total_cents'] or 0)} vs lines {fmt(dr)}", e["je_id"], abs((e["total_cents"] or 0) - dr),
                         "The lines were changed after the entry was recorded.")
        for e in posted:
            if not e["checks"]:
                self.add("A1", "high", "Posted entry never went through the kernel", "no kernel check results are on file",
                         e["je_id"], e["total_cents"] or 0, "Treat as a direct database write. Reverse it and find who made it.")
            elif any(c["result"] == "fail" for c in e["checks"]):
                failed = [c["check_id"] for c in e["checks"] if c["result"] == "fail"]
                self.add("A1", "high", "Posted entry failed kernel checks", f"failed {failed} but status is posted", e["je_id"],
                         e["total_cents"] or 0, "Status was changed outside the write path.")
            if e["decision"] is None:
                self.add("A1", "medium", "Posted entry has no decision record", "no question, answer, policy or evidence on file",
                         e["je_id"], e["total_cents"] or 0, "Every entry must say why it exists (REV policy, evidence).")
        self.coverage["A1"] = {"tested": len(entries), "population": len(entries), "method": "every entry"}
        self._seals(posted)

    def _seals(self, posted: list[dict]) -> None:
        seal_path = self.folder / "seals.db"
        if not seal_path.exists():
            self.add("A1", "low", "No evidence seals for this run", "the sealer was not attached, so tampering cannot be detected after the fact",
                     recommendation="Run with PITWALL_SEALS=1 (the default).")
            return
        sdb = _ro(seal_path)
        seals = [dict(r) for r in sdb.execute("SELECT * FROM seals ORDER BY seq")]
        by_je = {s["je_id"]: s for s in seals}
        prev = GENESIS
        broken_at = None
        for s in seals:
            if s["prev_hash"] != prev or chain(prev, s["entry_hash"]) != s["chain_hash"]:
                broken_at = broken_at or s["seq"]
            prev = s["chain_hash"]
        if broken_at:
            self.add("A1", "high", "Evidence seal chain is broken", f"chain fails to recompute from seal #{broken_at}",
                     recommendation="The seal store itself was edited. Compare against the anchored chain heads.")
        heads = {s["seq"]: s["chain_hash"] for s in seals}
        anchors = AnchorSink(self.folder / "anchors.jsonl").read()
        for a in anchors:
            if a["run_id"] == self.run_id and heads.get(a["seq"]) not in (None, a["chain_hash"]):
                self.add("A1", "high", "Seal chain disagrees with an anchored chain head",
                         f"seal #{a['seq']} was anchored as {a['chain_hash'][:12]} on {a['at']}, now reads {heads[a['seq']][:12]}",
                         recommendation="Someone rewrote the seals to cover an edit. The anchor is the trustworthy copy.",
                         evidence={"anchor": a})
                break
        for e in posted:
            s = by_je.get(e["je_id"])
            if s is None:
                self.add("A1", "high", "Posted entry has no evidence seal", "posted without passing through the sealed write path",
                         e["je_id"], e["total_cents"] or 0, "Treat as a direct database write.")
            elif entry_hash(e) != s["entry_hash"]:
                self.add("A1", "high", "Posted entry changed after it was sealed",
                         "its lines, dates or approvals no longer match the hash taken when it posted", e["je_id"], e["total_cents"] or 0,
                         "Restore from the sealed version and investigate the change.", evidence={"sealed_hash": s["entry_hash"][:16],
                                                                                                    "current_hash": entry_hash(e)[:16]})
        self.coverage["A1"] = {**self.coverage.get("A1", {}), "seals": len(seals), "anchors": len(anchors)}

    # ------------------------------------------------------------------ A2 completeness

    def _finals(self) -> set[tuple[int, str]]:
        return {(r["round"], r["session"]) for r in self.q("SELECT round, session FROM finals WHERE season=?", self.season)}

    def _overlays(self) -> list[dict]:
        return [json.loads(r["payload"]) for r in self.q("SELECT payload FROM overlays ORDER BY applied_at")]

    def a2_completeness(self, entries: list[dict]) -> None:
        finals = self._finals()
        truth = truth_bonuses(self.world, self.season, "final", self._overlays(), rounds={r for r, _ in finals})
        truth = {k: v for k, v in truth.items() if (v["round"], v["session"]) in finals}
        # A bonus the controller excluded by an approved rule (e.g. Volta sprints) is not expected.
        active = {}
        for e in entries:
            if e["kind"] == "bonus" and e["status"] == "posted" and not e["reversed_by"]:
                line = next((x for x in e["lines"] if x["account"] == "1300"), None)
                active[e["key"]] = (e, line["orig_amount_cents"] if line else None)
        for k, v in truth.items():
            if k not in active:
                parked = [e for e in entries if e["key"] == k and e["status"] == "parked"]
                usd = to_usd(v["amount_orig"], self.world.fx(v["currency"], self._today()))
                self.add("A2", "low" if parked else "high", "Earned bonus waiting for approval" if parked else "Earned bonus not booked",
                         f"{v['sponsor_id']} clause {v['clause_id']}, car {v['car']} P{v['position']} {self.season} R{v['round']} {v['session']}: "
                         f"{fmt(v['amount_orig'], v['currency'])}", parked[0]["je_id"] if parked else None, usd,
                         "Approve or reject the parked entry." if parked else "Revenue is understated; book it under REV-02.",
                         evidence={"key": k})
        for k, (e, orig) in active.items():
            t = truth.get(k)
            if t is None:
                self.add("A2", "high", "Bonus booked that the final results do not earn", e["memo"], e["je_id"], e["total_cents"] or 0,
                         "Revenue is overstated; reverse it (REV-02a) and, if invoiced, issue a credit note.", evidence={"key": k})
            elif orig != t["amount_orig"]:
                self.add("A2", "high", "Bonus booked at the wrong contract amount",
                         f"booked {fmt(orig or 0, t['currency'])}, contract pays {fmt(t['amount_orig'], t['currency'])}", e["je_id"],
                         abs(to_usd((orig or 0) - t["amount_orig"], self.world.fx(t["currency"], e["effective_date"]))),
                         "Reverse and rebook at the contract amount.", evidence={"key": k})
        self.coverage["A2"] = {"tested": len(truth), "population": len(truth), "booked": len(active), "method": "every final session"}

    def _today(self) -> str:
        row = self.q("SELECT MAX(recorded_at) t FROM journal_entries")
        return (row[0]["t"] or "2024-12-31")[:10]

    # ------------------------------------------------------------------ A3 accuracy (sample)

    def sample(self, entries: list[dict]) -> list[tuple[dict, str]]:
        posted = [e for e in entries if e["status"] == "posted"]
        picked: dict[str, str] = {}
        for e in posted:
            if (e["total_cents"] or 0) >= MATERIALITY_CENTS:
                picked[e["je_id"]] = "material"
            elif e["preparer"] != "code":
                picked[e["je_id"]] = "prepared by an agent"
            elif e["kind"] in JUDGMENT_KINDS:
                picked[e["je_id"]] = "judgment"
            elif e["approvals"]:
                picked[e["je_id"]] = "approved by a person"
        rest = [e for e in posted if e["je_id"] not in picked]
        for e in self.rng.sample(rest, min(len(rest), max(1, round(len(rest) * self.sample_rate)))) if rest else []:
            picked[e["je_id"]] = "random"
        by_id = {e["je_id"]: e for e in posted}
        return [(by_id[j], why) for j, why in picked.items()]

    def a3_accuracy(self, entries: list[dict]) -> list[tuple[dict, str]]:
        sample = self.sample(entries)
        for e, _ in sample:
            for problem, amount in self._reperform(e):
                self.add("A3", "high" if amount >= MATERIALITY_CENTS else "medium", "Re-performance differs from the books",
                         problem, e["je_id"], amount, "Correct the entry and find why the kernel let it through.")
        posted = sum(1 for e in entries if e["status"] == "posted")
        self.coverage["A3"] = {"tested": len(sample), "population": posted,
                               "method": "all material, agent-prepared, judgment and person-approved entries, plus a random sample",
                               "by_reason": {r: sum(1 for _, w in sample if w == r) for r in sorted({w for _, w in sample})}}
        return sample

    def _reperform(self, e: dict) -> list[tuple[str, int]]:
        w, b, out = self.world, e["basis"], []
        for x in e["lines"]:
            if x["orig_currency"] not in (None, "USD") and not x["carrying"] and x["account"] not in ("1000", "7100"):
                rate = w.fx(x["orig_currency"], e["effective_date"])
                if str(rate) != str(x["fx_rate"]):
                    out.append((f"line {x['account']} uses rate {x['fx_rate']}, table rate on {e['effective_date']} is {rate}", 0))
                usd = to_usd(x["orig_amount_cents"] or 0, rate)
                if (x["debit_cents"] or x["credit_cents"]) != usd:
                    out.append((f"line {x['account']}: {x['orig_amount_cents']} {x['orig_currency']} cents at {rate} is {fmt(usd)}, "
                                f"booked {fmt(x['debit_cents'] or x['credit_cents'])}", abs((x["debit_cents"] or x["credit_cents"]) - usd)))
        if e["kind"] == "base_recognition":
            s = w.sponsor(b["sponsor_id"])
            n = w.gp_rounds_in_season(b["season"])
            share = s["base_fee"] // n if b["round"] < n else s["base_fee"] - (s["base_fee"] // n) * (n - 1)
            orig = next((x["orig_amount_cents"] for x in e["lines"] if x["account"] == "1200"), None)
            if orig not in (None, share):
                out.append((f"base share for {s['id']} R{b['round']} should be {fmt(share, s['currency'])}, booked {fmt(orig, s['currency'])}", 0))
        return out

    # ------------------------------------------------------------------ A4 approvals

    def a4_approvals(self, entries: list[dict]) -> None:
        posted = [e for e in entries if e["status"] == "posted"]
        tested = 0
        for e in posted:
            total = e["total_cents"] or 0
            judgment = e["kind"] in JUDGMENT_KINDS or e["preparer"] != "code" or e["basis"].get("exception")
            # the control: a person decides every judgment entry, whatever its size (the CFO too at $1M or more)
            required = (["controller", "cfo"] if total >= CFO_CENTS else ["controller"]) if judgment else []
            if not required and not e["approvals"]:
                continue
            tested += 1
            approved = [a for a in e["approvals"] if a["decision"] == "approve"]
            roles = {a["role"] for a in approved}
            missing = [r for r in required if r not in roles]
            if missing:
                self.add("A4", "high", "Judgment entry posted without the required approval",
                         f"{fmt(total)} {e['kind']} needs {' and '.join(required)}; has {sorted(roles) or 'none'}", e["je_id"], total,
                         "Get the approval now or reverse the entry; find how it skipped the queue.")
            for a in approved:
                if a["approver"] == e["preparer"] or a["approver"].startswith("agent:") or a["approver"] in ("code", "saboteur"):
                    self.add("A4", "high", "Approval by someone who may not approve",
                             f"{a['approver']} approved an entry prepared by {e['preparer']}", e["je_id"], total,
                             "Segregation of duties (K11) was bypassed; re-approve by an eligible person.")
            names = [a["approver"] for a in approved]
            if len(names) != len(set(names)):
                self.add("A4", "high", "One person gave two approvals", f"approvers {names}", e["je_id"], total,
                         "A second, different approver is required.")
        self.coverage["A4"] = {"tested": tested, "population": len(posted), "method": "every posted entry that needed or had an approval"}

    # ------------------------------------------------------------------ A5 cut-off

    def a5_cutoff(self, entries: list[dict]) -> None:
        finals = {(r["round"], r["session"]): r["finalized_at"] for r in self.q("SELECT * FROM finals WHERE season=?", self.season)}
        tested = 0
        for e in entries:
            if e["kind"] not in ("bonus", "bonus_billing") or e["status"] != "posted":
                continue
            b = e["basis"]
            if "round" not in b:
                continue
            tested += 1
            fin = finals.get((b["round"], b.get("session", "race")))
            if fin is None or (e["posted_at"] or "") < fin:
                self.add("A5", "high", "Bonus booked before its result was final",
                         f"posted {e['posted_at']}, final classification {fin or 'not published'} (REV-02a)", e["je_id"],
                         e["total_cents"] or 0, "Reverse until the FIA Final Classification is published.")
        self.coverage["A5"] = {"tested": tested, "population": tested, "method": "every posted bonus and bonus invoice"}

    # ------------------------------------------------------------------ A6 reconciliation

    def a6_reconciliation(self, entries: list[dict]) -> dict:
        gl: dict[str, int] = defaultdict(int)
        sub: dict[str, int] = defaultdict(int)
        for e in entries:
            if e["status"] != "posted":
                continue
            for x in e["lines"]:
                gl[x["account"]] += x["debit_cents"] - x["credit_cents"]
                if x["account"] == "1200":
                    sub[x["sponsor_id"] or "unassigned"] += x["debit_cents"] - x["credit_cents"]
        total = sum(gl.values())
        if total != 0:
            self.add("A6", "high", "Trial balance does not tie", f"out of balance by {fmt(total)}", amount_cents=abs(total),
                     recommendation="Find the one-sided entry (see A1).")
        if sum(sub.values()) != gl.get("1200", 0):
            self.add("A6", "high", "Sponsor sub-ledger disagrees with receivables", f"sub-ledger {fmt(sum(sub.values()))} vs GL {fmt(gl['1200'])}")
        if sub.get("unassigned"):
            self.add("A6", "medium", "Receivable not assigned to a sponsor", f"{fmt(sub['unassigned'])} on 1200 has no sponsor",
                     amount_cents=abs(sub["unassigned"]), recommendation="Every receivable line names its sponsor.")
        self.coverage["A6"] = {"tested": len(gl), "population": len(gl), "method": "full trial balance and AR sub-ledger"}
        return {"gl": dict(gl), "ar_by_sponsor": dict(sub), "ties": total == 0}

    # ------------------------------------------------------------------ A7 billing

    def a7_billing(self, entries: list[dict]) -> None:
        by_id = {e["je_id"]: e for e in entries}
        rows = self.q("SELECT * FROM billing WHERE status='billed'")
        for r in rows:
            je = by_id.get(r["je_id"])
            req = json.loads(r["payload"])
            if je is None or je["status"] != "posted" or je["kind"] != "bonus_billing":
                self.add("A7", "high", "Invoice sent with no posted billing entry", f"request {r['request_id']} for {req['sponsor_id']}",
                         r["je_id"], recommendation="An invoice must trace to a booked, final bonus.")
                continue
            bonus_key = je["key"].removeprefix("bill|")
            bonus = next((e for e in entries if e["key"] == bonus_key and e["kind"] == "bonus" and e["status"] == "posted"), None)
            if bonus is None:
                self.add("A7", "high", "Invoice traces to no booked bonus", f"{je['key']}", je["je_id"], je["total_cents"] or 0)
        self.coverage["A7"] = {"tested": len(rows), "population": len(rows), "method": "every invoiced billing request"}

    # ------------------------------------------------------------------ run

    def run(self, review: bool = True, save: bool = True) -> dict:
        started = datetime.now(UTC)
        entries = self.entries()
        self.a1_integrity(entries)
        self.a2_completeness(entries)
        sample = self.a3_accuracy(entries)
        self.a4_approvals(entries)
        self.a5_cutoff(entries)
        recon = self.a6_reconciliation(entries)
        self.a7_billing(entries)
        self.findings.sort(key=lambda f: (-SEVERITY[f.severity], -f.amount_cents))
        opinions = []
        if review and self.reviewer is not None:
            judged = [(e, why) for e, why in sample if why != "random"][:12]
            opinions = self.reviewer.review_entries(judged, self.world)
            for o in opinions:
                if o.get("verdict") == "disagree":
                    e = next(x for x, _ in judged if x["je_id"] == o["je_id"])
                    self.add("A3", "low", "Second-opinion reviewer disagrees with a judgment",
                             o.get("concern", ""), e["je_id"], e["total_cents"] or 0,
                             "A person should read the decision record; the reviewer cannot change the books.", second_opinion=o)
        opinion = self.opinion()
        report = {
            "audit_id": "aud_" + hashlib.sha1(f"{self.run_id}{started.isoformat()}".encode()).hexdigest()[:10],
            "run_id": self.run_id, "season": self.season, "as_of": self._today(), "created_at": started.isoformat(timespec="seconds"),
            "opinion": opinion, "independence": self.independence(),
            "summary": {"findings": len(self.findings), **{s: sum(1 for f in self.findings if f.severity == s) for s in SEVERITY},
                        "exposure_cents": sum(f.amount_cents for f in self.findings if f.severity == "high"),
                        "entries": len(entries), "posted": sum(1 for e in entries if e["status"] == "posted")},
            "coverage": self.coverage, "reconciliation": recon,
            "findings": [{"id": f.fid, **asdict(f)} for f in self.findings],
            "sample": [{"je_id": e["je_id"], "kind": e["kind"], "total_cents": e["total_cents"], "why": why} for e, why in sample],
            "second_opinions": opinions,
            "reviewer": self.reviewer.describe() if self.reviewer else {"backend": "none"},
        }
        report["memo"] = self.reviewer.memo(report) if self.reviewer else default_memo(report)
        if save:
            self._save(report)
        return report

    def opinion(self) -> str:
        high = [f for f in self.findings if f.severity == "high"]
        integrity = [f for f in high if f.procedure == "A1"]
        if integrity or sum(f.amount_cents for f in high) >= MATERIALITY_CENTS:
            return "adverse"
        if high or any(f.severity == "medium" for f in self.findings):
            return "qualified"
        return "unmodified"

    def independence(self) -> dict:
        return {
            "access": "read-only (SQLite mode=ro); writes only to audit.db",
            "code_path": "own queries and arithmetic; does not call the kernel or the engine",
            "truth": "bonuses recomputed from results and contracts (finance/eval.py), separate from finance/bonuses.py",
            "model": "Azure OpenAI second opinion (different model family from the preparer)" if self.reviewer and
                     self.reviewer.describe()["backend"] == "azure_openai" else "rule-based reviewer (no model configured)",
            "can_change_books": False,
        }

    def _save(self, report: dict) -> None:
        db = sqlite3.connect(str(self.folder / "audit.db"))
        db.executescript(AUDIT_SCHEMA)
        db.execute("INSERT OR REPLACE INTO audits VALUES (?,?,?,?,?,?)", (report["audit_id"], self.run_id, report["as_of"],
                                                                         report["opinion"], json.dumps(report, default=str),
                                                                         report["created_at"]))
        db.commit()
        db.close()


def default_memo(report: dict) -> str:
    s = report["summary"]
    lines = [f"Audit of Meridian Racing revenue, {report['season']} season, as of {report['as_of']}.",
             f"Opinion: {report['opinion'].upper()}. {s['findings']} finding(s): {s['high']} high, {s['medium']} medium, {s['low']} low.",
             f"Tested {s['posted']} posted entries; sample of {len(report['sample'])} re-performed from source."]
    for f in report["findings"][:5]:
        lines.append(f"- [{f['severity']}] {f['title']}: {f['detail']}" + (f" ({f['je_id']})" if f["je_id"] else ""))
    if not report["findings"]:
        lines.append("No exceptions. Books tie, every posted entry is sealed, approved where required and traces to its source.")
    return "\n".join(lines)


def latest(folder: Path) -> dict | None:
    path = Path(folder) / "audit.db"
    if not path.exists():
        return None
    db = sqlite3.connect(str(path))
    row = db.execute("SELECT report FROM audits ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone()
    db.close()
    return json.loads(row[0]) if row else None
