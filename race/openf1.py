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
STATS = {"reads": 0, "cache": 0, "fetched": 0, "errors": 0}  # what this process asked the API for, shown on the dashboard


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
    STATS["reads"] += 1
    if cp.exists() and not refresh:
        STATS["cache"] += 1
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
        if r.status_code == 404 and "No results" in r.text:
            data = []  # an empty window (a red flag, before the start): a valid answer, cached like any other
        elif r.status_code != 200:
            raise OpenF1Error(f"{url}: HTTP {r.status_code} {r.text[:200]}")
        else:
            data = r.json()
        STATS["fetched"] += 1
        CACHE.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps(data))
        return data
    STATS["errors"] += 1
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


def load_telemetry(session: dict, driver_number: int, *, chunk_minutes: int = 10) -> list[dict]:
    """car_data (about 3.7 Hz: speed, rpm, throttle, brake, gear) for one car over the whole session, in chunks
    small enough for the free tier. Only the columns the tripwire reads are kept."""
    from datetime import datetime, timedelta

    start = datetime.fromisoformat(session["date_start"]) - timedelta(minutes=5)
    end = datetime.fromisoformat(session["date_end"]) + timedelta(minutes=90)  # red flags run long
    rows: list[dict] = []
    t = start
    while t < end:
        u = t + timedelta(minutes=chunk_minutes)
        chunk = get("car_data", session_key=session["session_key"], driver_number=driver_number,
                    **{"date>": t.isoformat(), "date<": u.isoformat()})
        rows.extend({"date": r["date"], "speed": r["speed"], "rpm": r["rpm"], "throttle": r["throttle"],
                     "brake": r["brake"], "n_gear": r["n_gear"]} for r in chunk)
        t = u
    return rows


def save_telemetry(session_key: int, drivers: list[int], out_dir: Path) -> None:
    import gzip

    s = session(session_key)
    out = out_dir / str(session_key)
    out.mkdir(parents=True, exist_ok=True)
    for car in drivers:
        rows = load_telemetry(s, car)
        with gzip.open(out / f"car_data_{car}.json.gz", "wt") as f:
            json.dump(rows, f, separators=(",", ":"))
        print(f"  car_data {session_key} #{car}: {len(rows)} rows")


def load_car_data(session_key: int, fixtures_dir: Path) -> dict[int, list[dict]]:
    """car -> telemetry rows from race/fixtures/<key>/car_data_<car>.json.gz (empty when not fetched)."""
    import gzip

    out: dict[int, list[dict]] = {}
    for p in sorted((fixtures_dir / str(session_key)).glob("car_data_*.json.gz")):
        with gzip.open(p, "rt") as f:
            out[int(p.name.split("_")[2].split(".")[0])] = json.load(f)
    return out


def load_fixture(session_key: int, fixtures_dir: Path) -> dict[str, list[dict]]:
    d = fixtures_dir / str(session_key)
    if not d.exists():
        raise OpenF1Error(f"no fixture for session {session_key} under {fixtures_dir}")
    out = {ep: json.loads((d / f"{ep}.json").read_text()) for ep in SESSION_ENDPOINTS if (d / f"{ep}.json").exists()}
    out["session"] = [json.loads((d / "session.json").read_text())] if (d / "session.json").exists() else []
    out["car_data"] = load_car_data(session_key, fixtures_dir)  # car -> rows (a dict, not a list: only our cars)
    return out
