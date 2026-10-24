"""Evidence seals: a hash chain over every posted entry, kept outside the books.

When an entry posts, the sealer hashes a canonical copy of it (lines, approvals,
dates, preparer) and chains that hash to the previous one. The seals live in
their own file (seals.db), not in the ledger, so someone who can edit the
ledger cannot quietly fix the evidence in the same place.

Every ANCHOR_EVERY seals, the chain head is written to an anchor: an
append-only file by default, and Azure Confidential Ledger when
AZURE_CONFIDENTIAL_LEDGER_ENDPOINT is set. An insider who rewrites both the
ledger and seals.db still cannot change an anchor that was already written.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS seals (seq INTEGER PRIMARY KEY, je_id TEXT UNIQUE, entry_hash TEXT, prev_hash TEXT,
  chain_hash TEXT, sealed_at TEXT);
"""
GENESIS = "0" * 64
ANCHOR_EVERY = int(os.environ.get("PITWALL_ANCHOR_EVERY", "25"))


def canonical(entry: dict) -> dict:
    """The parts of a posted entry that must never change after posting."""
    return {
        "je_id": entry["je_id"], "kind": entry["kind"], "period_id": entry["period_id"],
        "effective_date": entry["effective_date"], "posted_at": entry["posted_at"], "preparer": entry["preparer"],
        "key": entry.get("key"), "reverses_je_id": entry.get("reverses_je_id"), "sponsor_id": entry.get("sponsor_id"),
        "total_cents": entry["total_cents"], "decision_id": entry.get("decision_id"),
        "lines": [[x["account"], x["debit_cents"], x["credit_cents"], x["orig_currency"], x["orig_amount_cents"], x["fx_rate"],
                   x["sponsor_id"]] for x in sorted(entry["lines"], key=lambda x: x["line_no"])],
        "approvals": sorted([a["approver"], a["role"], a["decision"]] for a in entry.get("approvals", [])),
    }


def entry_hash(entry: dict) -> str:
    raw = json.dumps(canonical(entry), sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def chain(prev: str, h: str) -> str:
    return hashlib.sha256(f"{prev}:{h}".encode()).hexdigest()


class AnchorSink:
    """Append-only record of chain heads. Local file always; Azure Confidential Ledger when configured."""

    def __init__(self, path: Path, env=os.environ, http=None):
        self.path = Path(path)
        self.env = env
        self.http = http
        self.acl = env.get("AZURE_CONFIDENTIAL_LEDGER_ENDPOINT", "").rstrip("/")

    def write(self, run_id: str, seq: int, head: str) -> dict:
        record = {"run_id": run_id, "seq": seq, "chain_hash": head, "at": datetime.now(UTC).isoformat(timespec="seconds")}
        with self.path.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
        if self.acl:
            record["confidential_ledger"] = self._acl(record)
        return record

    def _acl(self, record: dict) -> str:
        """POST the head to Azure Confidential Ledger; returns its transaction id. Never raises."""
        try:
            import httpx

            from ..microsoft.auth import token

            http = self.http or httpx.Client(timeout=10)
            r = http.post(f"{self.acl}/app/transactions", params={"api-version": "2022-05-13", "collectionId": "pit-wall-seals"},
                          json={"contents": json.dumps(record)},
                          headers={"Authorization": f"Bearer {token('https://confidential-ledger.azure.com/.default', self.env)}"})
            return r.headers.get("x-ms-ccf-transaction-id", f"http {r.status_code}")
        except Exception as exc:  # anchoring must never break posting
            return f"failed: {exc}"[:200]

    def read(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text().splitlines() if line.strip()]


class Sealer:
    """Ledger listener. Seals each entry the first time it is seen posted."""

    def __init__(self, ledger, run_id: str, env=os.environ):
        self.ledger, self.run_id = ledger, run_id
        folder = Path(ledger.path).parent
        self.db = sqlite3.connect(str(folder / "seals.db"), check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.anchors = AnchorSink(folder / "anchors.jsonl", env)

    def head(self) -> tuple[int, str]:
        row = self.db.execute("SELECT seq, chain_hash FROM seals ORDER BY seq DESC LIMIT 1").fetchone()
        return (row[0], row[1]) if row else (0, GENESIS)

    def __call__(self, name: str, payload: dict) -> None:
        if name != "entry" or payload.get("status") != "posted":
            return
        if self.db.execute("SELECT 1 FROM seals WHERE je_id=?", (payload["je_id"],)).fetchone():
            return
        seq, prev = self.head()
        h = entry_hash(payload)
        head = chain(prev, h)
        self.db.execute("INSERT INTO seals VALUES (?,?,?,?,?,?)", (seq + 1, payload["je_id"], h, prev, head, self.ledger.clock))
        self.db.commit()
        if (seq + 1) % ANCHOR_EVERY == 0:
            self.anchors.write(self.run_id, seq + 1, head)

    def anchor_now(self) -> dict | None:
        seq, head = self.head()
        return self.anchors.write(self.run_id, seq, head) if seq else None


def attach(ledger, run_id: str, env=os.environ) -> Sealer | None:
    if env.get("PITWALL_SEALS", "1") == "0":
        return None
    s = Sealer(ledger, run_id, env)
    ledger.listeners.append(s)
    ledger.sealer = s
    return s
