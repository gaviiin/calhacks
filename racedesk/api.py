"""Race Desk HTTP endpoints (mounted by finance.api). All money is USD cents; clocks are UTC ISO 8601.

    GET /api/racedesk/races?season=2026            races with lap data
    GET /api/racedesk/replay/{season}/{round}      money telemetry, radio, crashes, speed scoreboard, totals
        ?team=mercedes   whose money (Meridian mirrors Mercedes)
        ?detail=false    drop per-lap car detail and running orders (smaller payload for a chart)
"""

from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, HTTPException

from .replay import races, replay

router = APIRouter(prefix="/api/racedesk", tags=["race desk"])


@lru_cache(maxsize=64)
def _cached(season: int, rnd: int, team: str) -> dict:
    return replay(season, rnd, team)


@router.get("/races")
def list_races(season: int = 2026):
    try:
        return races(season)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))


@router.get("/replay/{season}/{rnd}")
def get_replay(season: int, rnd: int, team: str = "mercedes", detail: bool = True):
    try:
        out = _cached(season, rnd, team)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if detail:
        return out
    return {**out, "laps": [{k: x[k] for k in ("lap", "clock", "total", "delta", "bonus_usd", "prize_ev")} for x in out["laps"]]}
