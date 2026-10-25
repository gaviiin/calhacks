"""Write race events, effects, forecasts and policies into the pit-wall SpacetimeDB database.

Same transport as finance/spacetime_mirror.py: the HTTP API's POST /v1/database/<db>/call/<reducer>
with a Bearer token. The identity behind the token needs the 'race' writer role (scripts/race_grant.py).
Disables itself with one message if the server or database is missing, so a replay still prints its tape.
"""

from __future__ import annotations

import os
import threading

import httpx

from finance.spacetime_mirror import cli_token
from race.events import Effect, RaceEvent, now_iso


class RaceSink:
    def __init__(self, base_url: str | None = None, database: str | None = None, token: str | None = None, quiet: bool = False):
        base = (base_url or os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000")).rstrip("/")
        self.db = database or os.environ.get("SPACETIME_DB", "pit-wall")
        self.url = f"{base}/v1/database/{self.db}"
        token = token or os.environ.get("SPACETIME_TOKEN", "") or cli_token()
        self.http = httpx.Client(timeout=10, headers={"Authorization": f"Bearer {token}"} if token else {})
        self.disabled = False
        self.errors = 0
        self.calls = 0
        self.quiet = quiet
        self._lock = threading.Lock()

    def call(self, reducer: str, args: list) -> bool:
        if self.disabled:
            return False
        with self._lock:
            try:
                r = self.http.post(f"{self.url}/call/{reducer}", json=args)
            except httpx.HTTPError as exc:
                self.disabled = True
                print(f"  SpacetimeDB unreachable at {self.url} ({exc}); sink off. Is `make stdb-start` running?")
                return False
            self.calls += 1
            if r.status_code == 404 and "not found" in r.text.lower():
                self.disabled = True
                print(f"  SpacetimeDB has no database {self.db}; sink off. Run `make evidence-publish` first.")
                return False
            if r.status_code != 200:
                self.errors += 1
                if not self.quiet:
                    print(f"  spacetime {reducer} -> {r.status_code}: {r.text.strip()[:200]}")
                return False
            return True

    def event(self, ev: RaceEvent) -> bool:
        # SATS-JSON option: {"some": row} | {"none": []}
        state = {"some": ev.state.wire()} if ev.state else {"none": []}
        return self.call("record_race_event", [ev.wire(now_iso()), state])

    def effects(self, ev: RaceEvent, effects: list[Effect]) -> bool:
        if not effects:
            return True
        return self.call("record_race_effects", [ev.key, [e.wire(ev, i) for i, e in enumerate(effects)]])

    def forecast(self, forecast: dict) -> bool:
        return self.call("record_forecast", [forecast])

    def propose_policy(self, policy: dict) -> bool:
        return self.call("propose_race_policy", [policy])

    def sql(self, query: str) -> list[dict]:
        """Read a public table (rows as dicts). Empty on any failure."""
        if self.disabled:
            return []
        try:
            r = self.http.post(f"{self.url}/sql", content=query, headers={"Content-Type": "text/plain"})
        except httpx.HTTPError:
            return []
        if r.status_code != 200:
            return []
        out: list[dict] = []
        for stmt in r.json():
            names = [_sats_name(c.get("name")) for c in stmt.get("schema", {}).get("elements", [])]
            for row in stmt.get("rows", []):
                out.append(dict(zip(names, row)))
        return out


def _sats_name(n) -> str:
    """SATS-JSON wraps optional names: {"some": "policy_id"} or ["policy_id"]."""
    if isinstance(n, dict):
        n = next(iter(n.values()), "")
    if isinstance(n, list):
        n = n[0] if n else ""
    return str(n)
