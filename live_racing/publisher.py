"""Publish race state, incident signals, Jev decisions and finance impacts to every sink at once.

Sinks: an in-memory bus (the API's /live/state and SSE stream), append-only JSONL (always, the
offline fallback), the existing SpacetimeDB `pit-wall` database through its `mirror_item` reducer
(the dashboard already subscribes to that database), and an optional webhook (FINANCE_AGENT_URL)
that receives incident and result-change signals for the cost cap / revenue desks.

Delivery is at least once; every record carries a stable id and a version so consumers can
upsert. Nothing here can write a journal entry, change a balance or approve anything: the only
reducer called is `mirror_item`, which stores an opaque payload.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

import httpx
from pydantic import BaseModel

SPACETIME_PAYLOAD_LIMIT = 8000  # mirror_item refuses payloads over 8192 chars


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _dump(obj: Any) -> dict:
    return obj.model_dump(mode="json") if isinstance(obj, BaseModel) else obj


class MemorySink:
    """Ring buffer + latest-by-(kind,id) + fan-out queues for SSE subscribers."""

    name = "memory"

    def __init__(self, maxlen: int = 5000):
        self.records: deque[dict] = deque(maxlen=maxlen)
        self.latest: dict[tuple[str, str], dict] = {}
        self.seq = 0
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def write(self, record: dict) -> None:
        with self._lock:
            self.seq += 1
            record = {**record, "seq": self.seq}
            self.records.append(record)
            self.latest[(record["kind"], record["id"])] = record
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(record)
            except queue.Full:
                pass

    def since(self, seq: int, kinds: Iterable[str] | None = None) -> list[dict]:
        ks = set(kinds) if kinds else None
        return [r for r in list(self.records) if r["seq"] > seq and (ks is None or r["kind"] in ks)]

    def of_kind(self, kind: str) -> list[dict]:
        return sorted((r for (k, _), r in self.latest.items() if k == kind), key=lambda r: r["seq"])

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)


class JsonlSink:
    name = "jsonl"

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.written = 0

    def write(self, record: dict) -> None:
        with open(self.path, "a") as f:
            f.write(json.dumps(record, separators=(",", ":"), default=str) + "\n")
        self.written += 1


class SpacetimeSink:
    """`mirror_item` on the pit-wall database: item_id live:<kind>:<id>, item_type live_<kind>."""

    name = "spacetimedb"

    def __init__(self, run_id: str, base_url: str | None = None, database: str | None = None, token: str | None = None,
                 http: httpx.Client | None = None):
        from finance.spacetime_mirror import cli_token

        self.run_id = run_id
        base = (base_url or os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000")).rstrip("/")
        self.database = database or os.environ.get("SPACETIME_DB", "pit-wall")
        self.url = f"{base}/v1/database/{self.database}"
        token = token or os.environ.get("SPACETIME_TOKEN", "") or cli_token()
        self.http = http or httpx.Client(timeout=10, headers={"Authorization": f"Bearer {token}"} if token else {})
        self.disabled = False
        self.disabled_reason: str | None = None
        self.errors = 0
        self.written = 0

    def write(self, record: dict) -> None:
        if self.disabled:
            return
        payload = record["payload"]
        text = json.dumps(record, separators=(",", ":"), default=str)
        truncated = False
        if len(text) > SPACETIME_PAYLOAD_LIMIT and isinstance(payload, dict) and "driver_states" in payload:
            team = set(payload.get("team_cars") or [])
            slim = {**payload, "driver_states": [d for d in payload["driver_states"] if d.get("driver_number") in team], "truncated": True}
            text = json.dumps({**record, "payload": slim}, separators=(",", ":"), default=str)
            truncated = True
        if len(text) > SPACETIME_PAYLOAD_LIMIT:
            text = json.dumps({**record, "payload": {"truncated": True, "note": "payload over the mirror limit; read it from /live/state"}}, default=str)
            truncated = True
        status = str((payload.get("status") if isinstance(payload, dict) else None) or record.get("status") or ("truncated" if truncated else ""))
        args = [f"live:{record['kind']}:{record['id']}", self.run_id, f"live_{record['kind']}", status[:64], text, record["published_at_utc"]]
        try:
            r = self.http.post(f"{self.url}/call/mirror_item", json=args)
        except httpx.HTTPError as exc:
            self.disabled, self.disabled_reason = True, f"SpacetimeDB unreachable at {self.url} ({exc.__class__.__name__}); mirror off"
            return
        if r.status_code == 404 and "not found" in r.text.lower():
            self.disabled, self.disabled_reason = True, f"no database {self.database} at {self.url}; mirror off (make evidence-publish)"
            return
        if r.status_code != 200:
            self.errors += 1
            if self.errors == 1:
                self.disabled_reason = f"mirror_item -> {r.status_code}: {r.text.strip()[:160]}"
            if self.errors >= 5:
                self.disabled, self.disabled_reason = True, f"mirror off after 5 errors; last: {r.status_code} {r.text.strip()[:120]}"
            return
        self.written += 1


class WebhookSink:
    """POSTs incident and result-change signals to the finance agent bridge, if one is configured."""

    name = "webhook"

    def __init__(self, url: str, kinds: Iterable[str] = ("incident_signal", "result_change"), http: httpx.Client | None = None, retries: int = 2):
        self.url = url
        self.kinds = set(kinds)
        self.http = http or httpx.Client(timeout=10)
        self.retries = retries
        self.sent = 0
        self.errors = 0
        self.last_error: str | None = None

    def write(self, record: dict) -> None:
        if record["kind"] not in self.kinds:
            return
        for attempt in range(self.retries + 1):
            try:
                r = self.http.post(self.url, json=record)
                if r.status_code < 300:
                    self.sent += 1
                    return
                self.last_error = f"HTTP {r.status_code}"
            except httpx.HTTPError as exc:
                self.last_error = exc.__class__.__name__
            if attempt < self.retries:
                time.sleep(0.5 * (attempt + 1))
        self.errors += 1


class Publisher:
    def __init__(self, sinks: list[Any], now=_now):
        self.sinks = sinks
        self.now = now
        self.published = 0
        self.publish_latencies_ms: list[int] = []

    def names(self) -> list[str]:
        out = []
        for s in self.sinks:
            if getattr(s, "disabled", False):
                out.append(f"{s.name} (off: {s.disabled_reason})")
            else:
                out.append(s.name)
        return out

    def publish(self, kind: str, obj: Any, *, id: str, version: int = 1, status: str | None = None, adapter_received_utc: str | None = None) -> dict:
        payload = _dump(obj)
        published_at = self.now()
        if adapter_received_utc:
            try:
                dt = datetime.fromisoformat(published_at.replace("Z", "+00:00")) - datetime.fromisoformat(adapter_received_utc.replace("Z", "+00:00"))
                self.publish_latencies_ms.append(max(0, int(dt.total_seconds() * 1000)))
            except ValueError:
                pass
        if isinstance(payload, dict) and "timestamps" in payload and isinstance(payload["timestamps"], dict):
            payload["timestamps"]["state_published"] = published_at
        record = {"kind": kind, "id": id, "version": version, "status": status, "published_at_utc": published_at, "payload": payload}
        for s in self.sinks:
            try:
                s.write(record)
            except Exception as exc:  # noqa: BLE001  a sink must never stop the race ticker
                record.setdefault("sink_errors", []).append(f"{s.name}: {exc.__class__.__name__}")
        self.published += 1
        return record

    def percentile(self, p: float) -> int | None:
        if not self.publish_latencies_ms:
            return None
        xs = sorted(self.publish_latencies_ms)
        return xs[min(len(xs) - 1, int(round((len(xs) - 1) * p)))]
