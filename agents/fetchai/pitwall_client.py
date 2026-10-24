"""Small client for the Pit Wall API, used by the Fetch.ai agents."""

from __future__ import annotations

import os

import httpx


class PitWall:
    def __init__(self, base: str | None = None, run_id: str | None = None, http: httpx.Client | None = None, season: int = 2024):
        self.base = (base or os.environ.get("PITWALL_API_URL", "http://localhost:8000")).rstrip("/")
        self.http = http or httpx.Client(timeout=30)
        self.run_id = run_id or os.environ.get("PITWALL_RUN_ID") or None
        self.pinned = bool(os.environ.get("PITWALL_RUN_ID"))
        self.season = int(os.environ.get("PITWALL_SEASON", season))

    def _send(self, method: str, path: str, **kw):
        r = self.http.request(method, f"{self.base}{path}", **kw)
        if r.status_code == 404 and self.run_id and path.startswith(f"/api/runs/{self.run_id}") and not self.pinned:
            # The API restarted and its in-memory runs are gone: pick up the current run once and retry.
            old, self.run_id = self.run_id, None
            r = self.http.request(method, f"{self.base}{path.replace(old, self.ensure_run(), 1)}", **kw)
        r.raise_for_status()
        return r.json()

    def _get(self, path: str, **params):
        return self._send("GET", path, params=params or None)

    def _post(self, path: str, body: dict | None = None):
        return self._send("POST", path, json=body or {})

    def ensure_run(self) -> str:
        """Use PITWALL_RUN_ID, the newest live run, or start one (full season, remittances left to agents)."""
        if self.run_id:
            return self.run_id
        runs = self._get("/api/runs")
        if runs:
            self.run_id = runs[-1]["run_id"]
        else:
            self.run_id = self._post("/api/runs", {"season": self.season, "cash": False})["run_id"]
        return self.run_id

    def run(self, path: str = "") -> str:
        return f"/api/runs/{self.ensure_run()}{path}"

    def summary(self) -> dict:
        return self._get(self.run("/summary"))

    def weekend(self, rnd: int) -> dict:
        return self._get(self.run(f"/weekend/{rnd}"))

    def queue(self) -> dict:
        return self._get(self.run("/queue"))

    def sponsors(self) -> list[dict]:
        return self._get(self.run("/sponsors"))

    def audit(self) -> dict:
        return self._post(self.run("/audit"), {})

    def impact(self) -> dict:
        return self._get(self.run("/impact"))

    def invoices(self, status: str = "open") -> list[dict]:
        return self._get(self.run("/invoices"), status=status)

    def payment(self, request_id: str, event: str, payer: str, transaction_id: str | None = None, reason: str | None = None) -> dict:
        return self._post(self.run(f"/invoices/{request_id}/payment"),
                          {"event": event, "payer": payer, "transaction_id": transaction_id, "reason": reason})

    def why(self, je_id: str) -> dict:
        return self._get(self.run(f"/entries/{je_id}/why"))
