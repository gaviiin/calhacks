"""Mirror the books into SpacetimeDB so the frontend gets every transaction live.

The Python kernel stays the system of record. This listener copies what it
posts into the public `journal_entries`, `je_lines` and `pit_wall_items`
tables through reducers that only the kernel identity may call (and that
refuse unbalanced entries on their own), and marks FIA documents as routed.

Enable with SPACETIME_MIRROR=1 (uses SPACETIME_URL, SPACETIME_DB, SPACETIME_TOKEN from .env).
"""

from __future__ import annotations

import hashlib
import json
import os

import httpx


def doc_key(season: int, slug: str, url: str) -> str:
    # Same formula as ingestion/ingest.py (captured URLs are already canonical).
    return hashlib.sha256(f"fia|{season}|{slug}|{url}".encode()).hexdigest()


class SpacetimeMirror:
    def __init__(self, run_id: str, base_url: str | None = None, database: str | None = None, token: str | None = None):
        self.run_id = run_id
        base = (base_url or os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000")).rstrip("/")
        self.url = f"{base}/v1/database/{database or os.environ.get('SPACETIME_DB', 'pit-wall')}"
        token = token or os.environ.get("SPACETIME_TOKEN", "")
        self.http = httpx.Client(timeout=10, headers={"Authorization": f"Bearer {token}"} if token else {})
        self.errors = 0

    def call(self, reducer: str, args: list) -> None:
        r = self.http.post(f"{self.url}/call/{reducer}", json=args)
        if r.status_code != 200:
            self.errors += 1
            print(f"  spacetime {reducer} -> {r.status_code}: {r.text.strip()[:200]}")

    def __call__(self, name: str, payload: dict) -> None:
        if name == "entry":
            e = payload
            d = e.get("decision") or {}
            self.call("mirror_entry", [{
                "je_id": e["je_id"], "run_id": self.run_id, "kind": e["kind"], "status": e["status"], "memo": e["memo"] or "",
                "sponsor_id": e["sponsor_id"] or "", "total_cents": e["total_cents"] or 0, "effective_date": e["effective_date"],
                "recorded_at": e["recorded_at"], "posted_at": e["posted_at"] or "", "preparer": e["preparer"],
                "needs": ",".join(e["needs"]), "reason": e["reason"] or "", "reverses_je_id": e["reverses_je_id"] or "",
                "policy_ids": ",".join(d.get("policy_ids", [])), "answer": (d.get("answer") or "")[:500],
            }, [{"account": x["account"], "debit_cents": x["debit_cents"], "credit_cents": x["credit_cents"],
                 "orig_currency": x["orig_currency"] or "USD", "orig_amount_cents": x["orig_amount_cents"] or 0,
                 "fx_rate": x["fx_rate"] or "", "sponsor_id": x["sponsor_id"] or ""} for x in e["lines"]]])
        elif name in ("memo", "question", "billing"):
            item_id = payload.get("memo_id") or payload.get("q_id") or payload.get("request_id")
            self.call("mirror_item", [{"item_id": f"{self.run_id}:{item_id}", "run_id": self.run_id, "item_type": name,
                                       "status": payload.get("status", ""), "payload_json": json.dumps(payload, default=str)[:8000],
                                       "updated_at": payload.get("at", "")}])
        elif name == "event":
            p = payload.get("payload", {})
            if p.get("url") and p.get("slug"):
                status = "linked_to_entry" if payload.get("acted") else ("routed" if payload["type"] != "fia_document" else "no_financial_impact")
                self.call("set_review_status", [doc_key(p["season"], p["slug"], p["url"]), status])


def maybe_attach(ledger, run_id: str) -> SpacetimeMirror | None:
    if os.environ.get("SPACETIME_MIRROR") != "1":
        return None
    mirror = SpacetimeMirror(run_id)
    ledger.listeners.append(mirror)
    return mirror
