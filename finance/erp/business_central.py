"""Dynamics 365 Business Central connector: send posted Pit Wall entries to the ERP's general journal.

Pit Wall is the sub-ledger that decides what revenue is; Business Central is
the system of record the finance team already closes in. Each posted entry
becomes one balanced set of general journal lines (same document number),
which a person posts in Business Central, or the connector posts when asked.

    BC_TENANT_ID        Entra tenant (defaults to MS_TENANT_ID)
    BC_ENVIRONMENT      e.g. Sandbox or Production
    BC_COMPANY_ID       company GUID (GET .../companies)
    BC_JOURNAL_ID       general journal batch GUID (GET .../companies({id})/journals)
    MS_CLIENT_ID, MS_CLIENT_SECRET   app registration with Business Central API.ReadWrite.All (application)
    BC_ACCOUNT_MAP      optional path to a JSON map of Pit Wall account -> BC G/L account number

API: Business Central API v2.0, journalLines (POST .../journals({id})/journalLines,
accountType "G/L Account", amount positive for debit, negative for credit) and the
bound action Microsoft.NAV.post.

Safety: export is idempotent (an entry is sent once; its documentNumber is the
je_id). Dry run (the default) builds the exact request bodies and sends nothing.
Only posted, sealed entries are sent. Amounts are USD, the functional currency;
the original currency amount and rate travel in the description.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ..config import ACCOUNTS, REPO

SCOPE = "https://api.businesscentral.dynamics.com/.default"
DEFAULT_MAP = REPO / "integrations" / "business_central_accounts.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS erp_exports (je_id TEXT PRIMARY KEY, system TEXT, mode TEXT, status TEXT, document_number TEXT,
  request TEXT, response TEXT, error TEXT, exported_at TEXT);
"""


class BCError(RuntimeError):
    pass


def account_map(env=os.environ) -> dict[str, str]:
    path = Path(env.get("BC_ACCOUNT_MAP") or DEFAULT_MAP)
    data = json.loads(path.read_text()) if path.exists() else {}
    return {a: str(data.get("accounts", {}).get(a, a)) for a in ACCOUNTS}


def external_ref(key: str | None) -> str:
    """'bill|bonus|2024|R10|race|halcyon|4.2|car44' -> 'bill-2024-R10-halcyon-4.2-c44' (BC allows 35 characters)."""
    parts = [p.replace("car", "c") for p in (key or "").split("|") if p and p != "race"]
    if len(parts) > 1 and parts[1] == "bonus":
        parts = [parts[0]] + parts[2:]
    return "-".join(parts)[:35]


def lines_for(entry: dict, mapping: dict[str, str]) -> list[dict]:
    """Business Central journalLines bodies for one posted entry (balanced: amounts sum to zero)."""
    out = []
    for x in sorted(entry["lines"], key=lambda x: x["line_no"]):
        amount = (x["debit_cents"] - x["credit_cents"]) / 100
        fx = ""
        if x.get("orig_currency") not in (None, "USD") and x.get("orig_amount_cents"):
            fx = f" [{x['orig_amount_cents'] / 100:,.2f} {x['orig_currency']}" + (f" @ {x['fx_rate']}]" if x.get("fx_rate") else "]")
        out.append({
            "accountType": "G/L Account",
            "accountNumber": mapping.get(x["account"], x["account"]),
            "postingDate": entry["effective_date"],
            "documentNumber": entry["je_id"][:20],
            "externalDocumentNumber": external_ref(entry.get("key")),
            "amount": amount,
            "description": (entry["memo"] + fx)[:100],
            "comment": f"Pit Wall {entry['kind']}; sponsor {x.get('sponsor_id') or '-'}; prepared by {entry['preparer']}"[:250],
        })
    total = round(sum(line["amount"] for line in out), 2)
    if total != 0:
        raise BCError(f"{entry['je_id']} does not balance ({total}); refusing to export")
    return out


class BusinessCentral:
    def __init__(self, ledger, env=os.environ, http: httpx.Client | None = None):
        self.ledger, self.env = ledger, env
        self.http = http or httpx.Client(timeout=20)
        self.mapping = account_map(env)
        ledger.db.executescript(SCHEMA)

    # ------------------------------------------------------------------ config

    @property
    def tenant(self) -> str:
        return self.env.get("BC_TENANT_ID") or self.env.get("MS_TENANT_ID", "")

    def configured(self) -> bool:
        from ..microsoft.auth import configured

        return bool(self.tenant and self.env.get("BC_ENVIRONMENT") and self.env.get("BC_COMPANY_ID") and self.env.get("BC_JOURNAL_ID")
                    and configured(self.env))

    def base(self) -> str:
        return (f"https://api.businesscentral.dynamics.com/v2.0/{self.tenant}/{self.env.get('BC_ENVIRONMENT', 'Sandbox')}/api/v2.0"
                f"/companies({self.env.get('BC_COMPANY_ID', '{companyId}')})")

    def journal_url(self) -> str:
        return f"{self.base()}/journals({self.env.get('BC_JOURNAL_ID', '{journalId}')})"

    def headers(self) -> dict:
        from ..microsoft.auth import token

        return {"Authorization": f"Bearer {token(SCOPE, self.env, self.http)}", "Content-Type": "application/json"}

    # ------------------------------------------------------------------ export

    def pending(self) -> list[dict]:
        rows = self.ledger.q("SELECT je_id FROM journal_entries WHERE status='posted' AND je_id NOT IN "
                             "(SELECT je_id FROM erp_exports WHERE status IN ('exported','posted_in_bc')) ORDER BY posted_at, rowid")
        return [self.ledger.entry(r["je_id"]) for r in rows]

    def export(self, mode: str = "dry", limit: int = 500, post: bool = False) -> dict:
        """Send pending posted entries. mode: dry (build bodies, send nothing) | live."""
        if mode == "live" and not self.configured():
            raise BCError("Business Central is not configured (see BC_* and MS_* in .env.example)")
        sealed = self._sealed()
        done, skipped, failed = [], [], []
        for entry in self.pending()[:limit]:
            if sealed is not None and entry["je_id"] not in sealed:
                skipped.append({"je_id": entry["je_id"], "reason": "no evidence seal; not exported"})
                continue
            try:
                body = lines_for(entry, self.mapping)
            except BCError as exc:
                failed.append({"je_id": entry["je_id"], "error": str(exc)})
                continue
            status, response, error = "dry_run", None, None
            if mode == "live":
                try:
                    response = [self._post_line(b) for b in body]
                    status = "exported"
                except (BCError, httpx.HTTPError) as exc:
                    status, error = "failed", str(exc)[:500]
            self._record(entry["je_id"], mode, status, body, response, error)
            (done if status != "failed" else failed).append({"je_id": entry["je_id"], "lines": len(body), "status": status,
                                                              **({"error": error} if error else {})})
        posted = None
        if post and mode == "live" and done:
            posted = self.post_journal()
        return {"system": "business_central", "mode": mode, "endpoint": f"{self.journal_url()}/journalLines",
                "exported": len(done), "skipped": skipped, "failed": failed, "entries": done[:50], "journal_posted": posted,
                "debits_usd": round(sum(b["amount"] for r in self._bodies(done) for b in r if b["amount"] > 0), 2)}

    def _bodies(self, done: list[dict]) -> list[list[dict]]:
        out = []
        for d in done:
            row = self.ledger.one("SELECT request FROM erp_exports WHERE je_id=?", d["je_id"])
            if row:
                out.append(json.loads(row["request"]))
        return out

    def _sealed(self) -> set[str] | None:
        sealer = getattr(self.ledger, "sealer", None)
        if sealer is None:
            return None
        return {r[0] for r in sealer.db.execute("SELECT je_id FROM seals")}

    def _post_line(self, body: dict) -> dict:
        r = self.http.post(f"{self.journal_url()}/journalLines", json=body, headers=self.headers())
        if r.status_code not in (200, 201):
            raise BCError(f"journalLines {r.status_code}: {r.text[:300]}")
        data = r.json()
        return {"id": data.get("id"), "lineNumber": data.get("lineNumber")}

    def post_journal(self) -> dict:
        """Post the journal batch in Business Central (bound action Microsoft.NAV.post)."""
        r = self.http.post(f"{self.journal_url()}/Microsoft.NAV.post", headers=self.headers())
        ok = r.status_code in (200, 204)
        if ok:
            self.ledger.db.execute("UPDATE erp_exports SET status='posted_in_bc' WHERE status='exported'")
            self.ledger.db.commit()
        return {"ok": ok, "status_code": r.status_code, "error": None if ok else r.text[:300]}

    def _record(self, je_id: str, mode: str, status: str, body, response, error) -> None:
        self.ledger.db.execute("INSERT OR REPLACE INTO erp_exports VALUES (?,?,?,?,?,?,?,?,?)",
                               (je_id, "business_central", mode, status, je_id[:20], json.dumps(body),
                                json.dumps(response) if response else None, error, datetime.now(UTC).isoformat(timespec="seconds")))
        self.ledger.db.commit()

    # ------------------------------------------------------------------ status and reconciliation

    def status(self) -> dict:
        rows = self.ledger.q("SELECT status, COUNT(*) n FROM erp_exports GROUP BY status")
        posted = self.ledger.one("SELECT COUNT(*) n FROM journal_entries WHERE status='posted'")["n"]
        return {"configured": self.configured(), "endpoint": f"{self.journal_url()}/journalLines", "posted_in_pit_wall": posted,
                "by_status": {r["status"]: r["n"] for r in rows}, "pending": len(self.pending()), "account_map": self.mapping}

    def reconcile(self) -> dict:
        """Compare what Pit Wall sent with Business Central's general ledger entries for those document numbers."""
        sent: dict[str, float] = {}
        for r in self.ledger.q("SELECT request FROM erp_exports WHERE status IN ('exported','posted_in_bc')"):
            for b in json.loads(r["request"]):
                sent[b["accountNumber"]] = round(sent.get(b["accountNumber"], 0) + b["amount"], 2)
        if not self.configured():
            return {"live": False, "sent_by_account": sent, "note": "configure Business Central to compare with its G/L"}
        docs = {r["document_number"] for r in self.ledger.q("SELECT document_number FROM erp_exports WHERE status='posted_in_bc'")}
        got: dict[str, float] = {}
        url = f"{self.base()}/generalLedgerEntries"
        while url:
            r = self.http.get(url, headers=self.headers())
            if r.status_code != 200:
                raise BCError(f"generalLedgerEntries {r.status_code}: {r.text[:300]}")
            data = r.json()
            for g in data.get("value", []):
                if g.get("documentNumber") in docs:
                    got[g["accountNumber"]] = round(got.get(g["accountNumber"], 0) + g.get("debitAmount", 0) - g.get("creditAmount", 0), 2)
            url = data.get("@odata.nextLink")
        expected = {}
        for r in self.ledger.q("SELECT request FROM erp_exports WHERE status='posted_in_bc'"):
            for b in json.loads(r["request"]):
                expected[b["accountNumber"]] = round(expected.get(b["accountNumber"], 0) + b["amount"], 2)
        diffs = {a: {"pit_wall": expected.get(a, 0), "business_central": got.get(a, 0)}
                 for a in set(expected) | set(got) if round(expected.get(a, 0) - got.get(a, 0), 2) != 0}
        return {"live": True, "documents": len(docs), "agrees": not diffs, "differences": diffs}

