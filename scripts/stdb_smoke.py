"""SpacetimeDB smoke test for the Pit Wall ledger mirror. Run with `spacetime start` up and the module published.

    .venv/bin/python scripts/stdb_smoke.py

Checks, against the live local database:
  1. the module answers SQL and has the ledger tables
  2. an anonymous identity cannot write to the ledger (role check in the reducer)
  3. even the owner cannot write an unbalanced entry (debits != credits, refused by the reducer)
  4. a balanced entry from the owner lands, and an update cannot change a posted entry back
  5. what the Pit Wall run mirrored so far: entries, lines, items, FIA documents by review status
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from finance.spacetime_mirror import cli_token  # noqa: E402

BASE = os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000").rstrip("/")
DB = os.environ.get("SPACETIME_DB", "pit-wall")
URL = f"{BASE}/v1/database/{DB}"
OK, BAD = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
failures = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global failures
    failures += not cond
    print(f"  {OK if cond else BAD}  {label}" + (f"  ({detail})" if detail else ""))


def sql(client: httpx.Client, q: str) -> list:
    r = client.post(f"{URL}/sql", content=q)
    r.raise_for_status()
    return r.json()[0]["rows"]


def entry(je_id: str, status: str, debit: int, credit: int) -> list:
    return [{"je_id": je_id, "run_id": "smoke", "kind": "bonus", "status": status, "memo": "smoke test", "sponsor_id": "halcyon",
             "total_cents": debit, "effective_date": "2024-07-28", "recorded_at": "2024-07-28T17:56:00Z", "posted_at": "",
             "preparer": "code", "needs": "", "reason": "", "reverses_je_id": "", "policy_ids": "REV-02", "answer": "smoke"},
            [{"account": "1300", "debit_cents": debit, "credit_cents": 0, "orig_currency": "USD", "orig_amount_cents": debit, "fx_rate": "", "sponsor_id": "halcyon"},
             {"account": "4010", "debit_cents": 0, "credit_cents": credit, "orig_currency": "USD", "orig_amount_cents": credit, "fx_rate": "", "sponsor_id": "halcyon"}]]


def main() -> int:
    token = os.environ.get("SPACETIME_TOKEN") or cli_token()
    if not token:
        print("No token: run `spacetime login` (or set SPACETIME_TOKEN) first.")
        return 2
    owner = httpx.Client(timeout=10, headers={"Authorization": f"Bearer {token}"})
    anon = httpx.Client(timeout=10)
    print(f"SpacetimeDB {URL}")
    try:
        tables = {"journal_entries", "je_lines", "pit_wall_items", "fia_documents"}
        for t in sorted(tables):
            sql(owner, f"SELECT COUNT(*) AS n FROM {t}")
        check("module answers and has the ledger tables", True)
    except httpx.HTTPError as exc:
        check("module answers and has the ledger tables", False, str(exc)[:200])
        print("Is `spacetime start` running and the module published (`npm run stdb:publish:local`)?")
        return 1

    jid = f"smoke_{uuid.uuid4().hex[:8]}"
    r = anon.post(f"{URL}/call/mirror_entry", json=entry(jid + "_anon", "posted", 100, 100))
    check("anonymous identity cannot write the ledger", r.status_code != 200, f"{r.status_code} {r.text.strip()[:80]}")
    r = owner.post(f"{URL}/call/mirror_entry", json=entry(jid + "_bad", "posted", 100, 99))
    check("unbalanced entry refused by the database itself", r.status_code != 200, f"{r.status_code} {r.text.strip()[:80]}")
    r = owner.post(f"{URL}/call/mirror_entry", json=entry(jid, "posted", 100, 100))
    check("balanced entry from the kernel identity lands", r.status_code == 200, f"{r.status_code} {r.text.strip()[:80]}")
    r = owner.post(f"{URL}/call/mirror_entry", json=entry(jid, "parked", 100, 100))
    check("posted entry cannot be changed back to parked", r.status_code != 200, f"{r.status_code} {r.text.strip()[:80]}")

    print("\nWhat the Pit Wall run has mirrored:")
    n_entries = sql(owner, "SELECT COUNT(*) AS n FROM journal_entries")[0][0]
    n_lines = sql(owner, "SELECT COUNT(*) AS n FROM je_lines")[0][0]
    n_items = sql(owner, "SELECT COUNT(*) AS n FROM pit_wall_items")[0][0]
    print(f"  journal_entries {n_entries}, je_lines {n_lines}, pit_wall_items {n_items}")
    statuses: dict[str, int] = {}
    for (status,) in sql(owner, "SELECT review_status FROM fia_documents"):
        statuses[status] = statuses.get(status, 0) + 1
    print(f"  fia_documents by review status: {statuses or 'none ingested yet'}")
    print(f"\n{'All checks passed.' if not failures else f'{failures} check(s) failed.'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
