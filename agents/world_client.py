"""HTTP client for the systems-of-record mock (SCHEMA.md §5, world API on :8010).

Read access (cursor API) is used by sync and the Policy Learner. `post_journal_entry` needs the
gateway key and is only ever called from agents.gateway.
"""

from __future__ import annotations

from typing import Iterator

import httpx

from .config import Config


class WorldError(RuntimeError):
    pass


class WorldClient:
    def __init__(self, url: str | None = None, http: httpx.Client | None = None, timeout: float = 30.0):
        self.url = (url or Config.from_env().world_url).rstrip("/")
        self.http = http or httpx.Client(timeout=timeout)

    def _get(self, path: str, **params) -> httpx.Response:
        r = self.http.get(f"{self.url}{path}", params=params or None)
        if r.status_code >= 400:
            raise WorldError(f"GET {path}: HTTP {r.status_code}: {r.text[:300]}")
        return r

    def clock(self) -> str:
        return self._get("/clock").json()["sim_date"]

    def sources(self) -> list[str]:
        return list(self._get("/sources").json())

    def changes(self, source: str, after: int = 0, limit: int = 500) -> dict:
        return self._get(f"/changes/{source}", after=after, limit=limit).json()

    def iter_changes(self, source: str, after: int = 0, limit: int = 500) -> Iterator[dict]:
        """Yield every change `{"cursor","op","record"}` after `after`, following pagination."""
        cursor = int(after)
        while True:
            page = self.changes(source, after=cursor, limit=limit)
            records = page.get("records") or []
            for ch in records:
                yield ch
            nxt = page.get("next_cursor")
            if records:
                last = max(int(ch["cursor"]) for ch in records)
                nxt = max(int(nxt or 0), last)
            if not page.get("has_more") or nxt is None or int(nxt) <= cursor:
                return
            cursor = int(nxt)

    def all_records(self, source: str) -> list[dict]:
        """Latest version of every visible record of a source (upsert semantics, keyed by id)."""
        latest: dict[str, dict] = {}
        for ch in self.iter_changes(source, 0):
            if ch.get("op", "upsert") == "upsert":
                latest[ch["record"]["id"]] = ch["record"]
        return list(latest.values())

    def record(self, source: str, record_id: str) -> dict | None:
        r = self.http.get(f"{self.url}/records/{source}/{record_id}")
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise WorldError(f"GET /records/{source}/{record_id}: HTTP {r.status_code}")
        return r.json()

    def post_journal_entry(self, body: dict, gateway_key: str) -> str:
        """POST /erp/journal_entries with X-Gateway-Key. Returns the ERP entry id.

        `body["work_item_id"]` is the idempotency key; we also send it as an Idempotency-Key header
        so the ERP mock can return the existing entry for a retried post.
        """
        r = self.http.post(
            f"{self.url}/erp/journal_entries",
            json=body,
            headers={"X-Gateway-Key": gateway_key, "Idempotency-Key": f"work_item:{body['work_item_id']}"},
        )
        if r.status_code >= 400:
            raise WorldError(f"POST /erp/journal_entries: HTTP {r.status_code}: {r.text[:300]}")
        return r.json()["erp_entry_id"]
