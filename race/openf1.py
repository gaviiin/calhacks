"""OpenF1 REST client for the race desk: cached, rate-limited, replay-friendly.

Free tier is historical only and allows about 30 requests a minute (HTTP 429 beyond that), so
every GET is cached on disk under race/.cache and paced at MIN_INTERVAL seconds. Live data goes
through race/live.py (MQTT), not here.

    rows = load_session(11291)          # dict endpoint -> rows, every driver
    rows["race_control"][0]["message"]
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx

BASE = os.environ.get("OPENF1_BASE", "https://api.openf1.org/v1")
CACHE = Path(os.environ.get("OPENF1_CACHE", Path(__file__).resolve().parent / ".cache"))
MIN_INTERVAL = float(os.environ.get("OPENF1_MIN_INTERVAL", "2.5"))
USER_AGENT = "pit-wall-race-desk/0.1 (+https://github.com/gaviiin/calhacks)"

# The endpoints a race session replay needs, in the order they are fetched.
SESSION_ENDPOINTS = (
    "drivers", "laps", "position", "intervals", "stints", "pit", "overtakes", "race_control",
    "championship_teams", "session_result",
)

_last_call = 0.0


class OpenF1Error(RuntimeError):
    pass


def _cache_path(path: str, params: dict) -> Path:
    key = hashlib.sha256(f"{path}?{urlencode(sorted(params.items()))}".encode()).hexdigest()[:32]
    return CACHE / f"{path.strip('/').replace('/', '_')}-{key}.json"


def get(path: str, *, refresh: bool = False, **params) -> list[dict]:
    """GET one endpoint. Cached on disk; 429s back off and retry up to five times."""
    global _last_call
    params = {k: v for k, v in params.items() if v is not None}
    cp = _cache_path(path, params)
    if cp.exists() and not refresh:
        return json.loads(cp.read_text())
    url = f"{BASE}/{path.strip('/')}"
    delay = 20.0
    for attempt in range(6):
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        try:
            r = httpx.get(url, params=params, timeout=30, headers={"User-Agent": USER_AGENT})
        except httpx.HTTPError as exc:
            if attempt == 5:
                raise OpenF1Error(f"{url}: {exc}") from exc
            time.sleep(delay)
            continue
        if r.status_code == 429:
            time.sleep(delay)
            delay *= 1.5
            continue
        if r.status_code == 401:
            raise OpenF1Error(f"{url}: 401 (historical data is locked during live sessions; try later)")
        if r.status_code != 200:
            raise OpenF1Error(f"{url}: HTTP {r.status_code} {r.text[:200]}")
        data = r.json()
        CACHE.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps(data))
        return data
    raise OpenF1Error(f"{url}: rate limited after retries")


def load_session(session_key: int, *, endpoints=SESSION_ENDPOINTS, refresh: bool = False) -> dict[str, list[dict]]:
    """Every row of every endpoint for one session, keyed by endpoint name."""
    out: dict[str, list[dict]] = {}
    for ep in endpoints:
        try:
            out[ep] = get(ep, session_key=session_key, refresh=refresh)
        except OpenF1Error as exc:
            # Some endpoints are missing for some sessions (overtakes, standings); the normaliser copes.
            out[ep] = []
            print(f"  openf1: {ep} unavailable for session {session_key}: {exc}")
    return out


def session(session_key: int) -> dict:
    rows = get("sessions", session_key=session_key)
    if not rows:
        raise OpenF1Error(f"no session {session_key}")
    return rows[0]


def meetings(year: int) -> list[dict]:
    return sorted(get("meetings", year=year), key=lambda m: m["date_start"])


def sessions(year: int, session_type: str = "Race") -> list[dict]:
    return sorted(get("sessions", year=year, session_type=session_type), key=lambda s: s["date_start"])


def save_fixture(session_key: int, out_dir: Path) -> Path:
    """Download a session once into race/fixtures/<key>/ so tests and offline replays need no network."""
    out = out_dir / str(session_key)
    out.mkdir(parents=True, exist_ok=True)
    (out / "session.json").write_text(json.dumps(session(session_key), indent=1))
    for ep, rows in load_session(session_key).items():
        (out / f"{ep}.json").write_text(json.dumps(rows))
    return out


def load_fixture(session_key: int, fixtures_dir: Path) -> dict[str, list[dict]]:
    d = fixtures_dir / str(session_key)
    if not d.exists():
        raise OpenF1Error(f"no fixture for session {session_key} under {fixtures_dir}")
    out = {ep: json.loads((d / f"{ep}.json").read_text()) for ep in SESSION_ENDPOINTS if (d / f"{ep}.json").exists()}
    out["session"] = [json.loads((d / "session.json").read_text())] if (d / "session.json").exists() else []
    return out
