"""OpenF1 REST client with a deterministic on-disk cache and honest provenance.

Every successful response is stored unmodified under <cache_dir>/raw/<endpoint>__<params>.json
and listed in <cache_dir>/raw/manifest.json with source_url, retrieved_at, sha256 and row count.
Rate limits (OpenF1 free tier: ~3 requests/s, 30/min) are respected with a minimum interval and
bounded retries; failures surface as OpenF1Error with the URL and status, never as silent gaps.

Live MQTT (authenticated supporters, P2) would plug in behind the same normalizer; it is not here.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .config import DEFAULT_OPENF1_BASE_URL


class OpenF1Error(RuntimeError):
    pass


@dataclass
class FetchResult:
    endpoint: str
    params: dict[str, Any]
    rows: list[dict]
    source_url: str
    retrieved_at: str
    sha256: str
    from_cache: bool
    status: int | None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def cache_key(endpoint: str, params: dict[str, Any]) -> str:
    items = sorted((k, str(v)) for k, v in params.items())
    flat = "&".join(f"{k}={v}" for k, v in items)
    flat = re.sub(r"[^A-Za-z0-9=&._-]", "_", flat)
    if len(flat) > 120:
        flat = flat[:100] + "_" + hashlib.sha1(flat.encode()).hexdigest()[:12]
    return f"{endpoint}__{flat}" if flat else endpoint


class OpenF1Client:
    def __init__(self, cache_dir: Path, base_url: str = DEFAULT_OPENF1_BASE_URL, *, http: httpx.Client | None = None,
                 min_interval_s: float = 0.45, max_retries: int = 4, timeout_s: float = 40.0, sleep=time.sleep,
                 offline: bool = False):
        self.base_url = base_url.rstrip("/")
        self.raw_dir = Path(cache_dir) / "raw"
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.raw_dir / "manifest.json"
        self.http = http or httpx.Client(timeout=timeout_s, headers={"User-Agent": "pit-wall-live-racing (hackathon)"})
        self.min_interval_s = min_interval_s
        self.max_retries = max_retries
        self.sleep = sleep
        self.offline = offline
        self._last_call = 0.0
        self.requests = 0
        self.cache_hits = 0

    # ------------------------------------------------------------------ manifest

    def manifest(self) -> dict:
        if self.manifest_path.exists():
            return json.loads(self.manifest_path.read_text())
        return {"source_system": "openf1", "base_url": self.base_url, "entries": {}}

    def _record(self, key: str, entry: dict) -> None:
        m = self.manifest()
        m["entries"][key] = entry
        self.manifest_path.write_text(json.dumps(m, indent=1, sort_keys=True) + "\n")

    # ------------------------------------------------------------------ fetch

    def url_for(self, endpoint: str, params: dict[str, Any]) -> str:
        """OpenF1 filters are spelled `date>=2024-11-03T16:35:22`: the operator stays literal and the
        first `=` is the separator (an encoded `%3E%3D=` is treated as an unknown attribute and 404s)."""
        parts = []
        for k, v in sorted((k, str(v)) for k, v in params.items()):
            m = re.fullmatch(r"(\w+)(>=|<=)", k)
            if m:
                parts.append(f"{m.group(1)}{m.group(2)}{quote(v, safe='-:T.')}")
            else:
                parts.append(f"{quote(k, safe='')}={quote(v, safe='-:T.')}")
        return f"{self.base_url}/{endpoint}" + (f"?{'&'.join(parts)}" if parts else "")

    def get(self, endpoint: str, *, refresh: bool = False, **params: Any) -> FetchResult:
        key = cache_key(endpoint, params)
        path = self.raw_dir / f"{key}.json"
        url = self.url_for(endpoint, params)
        entry = self.manifest()["entries"].get(key)
        if path.exists() and entry and not refresh:
            rows = json.loads(path.read_text())
            self.cache_hits += 1
            return FetchResult(endpoint, params, rows, entry.get("source_url", url), entry.get("retrieved_at", ""),
                               entry.get("sha256", ""), True, entry.get("status"))
        if self.offline:
            raise OpenF1Error(f"offline and not cached: {url}")
        rows, status = self._request(url)
        text = json.dumps(rows, separators=(",", ":"), sort_keys=True)
        digest = hashlib.sha256(text.encode()).hexdigest()
        path.write_text(text + "\n")
        retrieved = _now()
        self._record(key, {"endpoint": endpoint, "params": {k: str(v) for k, v in params.items()}, "source_url": url,
                           "retrieved_at": retrieved, "sha256": digest, "rows": len(rows), "status": status, "file": path.name})
        return FetchResult(endpoint, params, rows, url, retrieved, digest, False, status)

    def _request(self, url: str) -> tuple[list[dict], int]:
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            wait = self.min_interval_s - (time.monotonic() - self._last_call)
            if wait > 0:
                self.sleep(wait)
            self._last_call = time.monotonic()
            self.requests += 1
            try:
                r = self.http.get(url)
            except httpx.HTTPError as exc:
                last_exc = exc
                self.sleep(min(10.0, 1.0 + attempt * 2 + random.random()))
                continue
            if r.status_code == 200:
                try:
                    data = r.json()
                except ValueError as exc:
                    raise OpenF1Error(f"{url}: response is not JSON ({exc})") from exc
                if not isinstance(data, list):
                    raise OpenF1Error(f"{url}: expected a JSON array, got {type(data).__name__}")
                return data, 200
            if r.status_code == 429 or r.status_code >= 500:
                retry_after = r.headers.get("Retry-After")
                delay = min(20.0, float(retry_after)) if retry_after and retry_after.isdigit() else min(20.0, 2.0 * (attempt + 1) + random.random())
                last_exc = OpenF1Error(f"{url}: HTTP {r.status_code}")
                self.sleep(delay)
                continue
            raise OpenF1Error(f"{url}: HTTP {r.status_code} {r.text[:200]}")
        raise OpenF1Error(f"{url}: gave up after {self.max_retries + 1} attempts ({last_exc})")


# ---------------------------------------------------------------------- discovery helpers


def find_race_session(sessions: list[dict], session_name: str = "Race") -> dict:
    """The Grand Prix itself: session_type 'Race' AND session_name 'Race' (a Sprint is also type Race)."""
    races = [s for s in sessions if s.get("session_type") == "Race" and s.get("session_name") == session_name]
    if len(races) != 1:
        raise OpenF1Error(f"expected exactly one {session_name!r} session, found {len(races)}: "
                          f"{[(s.get('session_key'), s.get('session_name')) for s in sessions]}")
    return races[0]


def parse_openf1_time(ts: str) -> datetime:
    """OpenF1 timestamps are ISO-8601 with an offset (usually +00:00); return an aware UTC datetime."""
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
