"""Tamper drill: an insider edits the books directly, bypassing the kernel. Does the auditor notice?

Each attack runs on its own copy of a run's files (ledger, seals, anchors), so
the real books are never touched. For every attack the drill reports which
audit findings appeared that were not there before.

    quiet_edit      raise a posted bonus on both lines, so the books still balance
    backdoor_entry  insert a balanced, "posted" bonus straight into the tables
    approval_swap   rewrite who approved a material entry to the person who prepared it
    cover_up        quiet edit, then recompute that entry's seal and the chain after it
"""

from __future__ import annotations

import hashlib
import shutil
import sqlite3
import tempfile
from pathlib import Path

from .auditor import Auditor
from .seal import GENESIS, chain, entry_hash

ATTACKS = ("quiet_edit", "backdoor_entry", "approval_swap", "cover_up")
BUMP = 5_000_000  # $50,000


def _copy(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("ledger.db", "seals.db", "anchors.jsonl"):
        if (src / name).exists():
            shutil.copy(src / name, dst / name)


def _target(db: sqlite3.Connection, prefer_approved: bool = False) -> str | None:
    sql = ("SELECT j.je_id FROM journal_entries j WHERE j.status='posted' AND j.kind=? "
           + ("AND EXISTS (SELECT 1 FROM approvals a WHERE a.je_id=j.je_id AND a.decision='approve') " if prefer_approved else "")
           + "ORDER BY j.rowid LIMIT 1")
    for kind in (("bonus_reversal", "prize_estimate_change", "bonus") if prefer_approved else ("bonus",)):
        row = db.execute(sql, (kind,)).fetchone()
        if row:
            return row[0]
    return None


def _quiet_edit(db: sqlite3.Connection) -> str | None:
    je = _target(db)
    if je:
        db.execute("UPDATE je_lines SET debit_cents=debit_cents+? WHERE je_id=? AND debit_cents>0", (BUMP, je))
        db.execute("UPDATE je_lines SET credit_cents=credit_cents+? WHERE je_id=? AND credit_cents>0", (BUMP, je))
        db.execute("UPDATE journal_entries SET total_cents=total_cents+? WHERE je_id=?", (BUMP, je))
    return je


def _backdoor(db: sqlite3.Connection) -> str:
    row = db.execute("SELECT * FROM journal_entries WHERE status='posted' AND kind='bonus' ORDER BY rowid DESC LIMIT 1").fetchone()
    je = "je_" + hashlib.sha1(b"backdoor").hexdigest()[:12]
    cols = [d[1] for d in db.execute("PRAGMA table_info(journal_entries)")]
    vals = dict(zip(cols, row))
    vals.update(je_id=je, key=(vals["key"] or "bonus") + "|extra", memo="Arcadia podium bonus (manual)", total_cents=40_000_000,
                preparer="code", decision_id=None)
    db.execute(f"INSERT INTO journal_entries ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", [vals[c] for c in cols])
    db.execute("INSERT INTO je_lines VALUES (?,?,?,?,?,?,?,?,?,?)", (je, 0, "1300", 40_000_000, 0, "USD", None, None, "arcadia", 0))
    db.execute("INSERT INTO je_lines VALUES (?,?,?,?,?,?,?,?,?,?)", (je, 1, "4010", 0, 40_000_000, "USD", None, None, "arcadia", 0))
    return je


def _approval_swap(db: sqlite3.Connection) -> str | None:
    je = _target(db, prefer_approved=True)
    if je:
        preparer = db.execute("SELECT preparer FROM journal_entries WHERE je_id=?", (je,)).fetchone()[0]
        db.execute("UPDATE approvals SET approver=? WHERE je_id=?", (preparer, je))
    return je


def _reseal(folder: Path, je_id: str, auditor: Auditor) -> None:
    """What a careful insider does next: rewrite the seal and every chain link after it."""
    entry = next(e for e in auditor.entries() if e["je_id"] == je_id)
    sdb = sqlite3.connect(str(folder / "seals.db"))
    rows = sdb.execute("SELECT seq, je_id, entry_hash FROM seals ORDER BY seq").fetchall()
    prev = GENESIS
    for seq, j, h in rows:
        if j == je_id:
            h = entry_hash(entry)
        head = chain(prev, h)
        sdb.execute("UPDATE seals SET entry_hash=?, prev_hash=?, chain_hash=? WHERE seq=?", (h, prev, head, seq))
        prev = head
    sdb.commit()
    sdb.close()


def _ids(report: dict) -> set[str]:
    return {f["id"] for f in report["findings"]}


def run(run_folder: Path, world, run_id: str, season: int, attacks: tuple[str, ...] = ATTACKS) -> dict:
    run_folder = Path(run_folder)
    base = Auditor(run_folder / "ledger.db", world, run_id, season).run(review=False, save=False)
    out = {"run_id": run_id, "baseline_opinion": base["opinion"], "baseline_findings": base["summary"]["findings"], "attacks": []}
    with tempfile.TemporaryDirectory() as tmp:
        for name in attacks:
            folder = Path(tmp) / name
            _copy(run_folder, folder)
            db = sqlite3.connect(str(folder / "ledger.db"))
            je = {"quiet_edit": _quiet_edit, "backdoor_entry": _backdoor, "approval_swap": _approval_swap, "cover_up": _quiet_edit}[name](db)
            db.commit()
            db.close()
            if name == "cover_up" and je:
                _reseal(folder, je, Auditor(folder / "ledger.db", world, run_id, season))
            rep = Auditor(folder / "ledger.db", world, run_id, season).run(review=False, save=False)
            new = [f for f in rep["findings"] if f["id"] not in _ids(base)]
            out["attacks"].append({
                "attack": name, "je_id": je, "caught": bool(new), "opinion": rep["opinion"],
                "caught_by": sorted({f"{f['procedure']}: {f['title']}" for f in new}),
                "books_still_tie": rep["reconciliation"]["ties"],
            })
    out["caught"] = sum(a["caught"] for a in out["attacks"])
    out["of"] = len(out["attacks"])
    return out
