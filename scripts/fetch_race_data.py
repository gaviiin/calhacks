"""Download lap-by-lap race data and cache it per season for Race Desk.

    python scripts/fetch_race_data.py 2023 2024 2026

Source: TracingInsights RaceData (CC0 1.0, Ergast-compatible tables, updated through the current season)
https://github.com/TracingInsights/RaceData . Writes world/race_data/<season>.json: for every race with lap
data, each car's position and lap time on every lap, pit stops, the classification with status, sprint
points, the constructors' standings after the race, and safety car windows.
"""

from __future__ import annotations

import csv
import io
import json
import sys
from collections import defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

BASE = "https://raw.githubusercontent.com/TracingInsights/RaceData/main/data/"
OUT = Path(__file__).resolve().parent.parent / "world" / "race_data"
TABLES = ["races", "results", "lap_times", "pit_stops", "safety_cars", "red_flags", "constructor_standings", "drivers",
          "constructors", "status", "sprint_results"]


def table(name: str, cache: Path | None) -> list[dict]:
    if cache and (cache / f"{name}.csv").exists():
        text = (cache / f"{name}.csv").read_text(encoding="utf-8-sig")
    else:
        with urlopen(Request(BASE + f"{name}.csv", headers={"User-Agent": "pit-wall-hackathon"}), timeout=120) as r:
            text = r.read().decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


def num(x: str, default=None):
    """Ergast tables write missing values as \\N."""
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return default


def build(seasons: list[int], cache: Path | None = None) -> dict[int, dict]:
    t = {n: table(n, cache) for n in TABLES}
    races = {r["raceId"]: r for r in t["races"] if int(r["year"]) in seasons}
    drivers = {r["driverId"]: r for r in t["drivers"]}
    cons = {r["constructorId"]: r for r in t["constructors"]}
    status = {r["statusId"]: r["status"] for r in t["status"]}
    laps = defaultdict(list)
    for r in t["lap_times"]:
        if r["raceId"] in races:
            laps[r["raceId"]].append(r)
    out: dict[int, dict] = {s: {"season": s, "source": "TracingInsights RaceData (CC0), https://github.com/TracingInsights/RaceData",
                                "total_rounds": sum(1 for r in races.values() if int(r["year"]) == s), "rounds": []} for s in seasons}
    for rid, race in sorted(races.items(), key=lambda kv: (int(kv[1]["year"]), int(kv[1]["round"]))):
        if rid not in laps:
            continue  # not raced yet
        res = [r for r in t["results"] if r["raceId"] == rid]
        car = {r["driverId"]: int(r["number"]) for r in res}
        per_lap: dict[int, dict[str, list]] = defaultdict(dict)
        for r in laps[rid]:
            per_lap[int(r["lap"])][str(car[r["driverId"]])] = [int(r["position"]), int(r["milliseconds"])]
        sc_name = f"{race['year']} {race['name']}"
        sc = [{"cause": r["Cause"], "from_lap": num(r["Deployed"]), "to_lap": num(r["Retreated"])}
              for r in t["safety_cars"] if r["Race"] == sc_name and num(r["Deployed"]) is not None]
        rf = [{"lap": num(r.get("Lap")), "incident": r.get("Incident", "")[:160]} for r in t["red_flags"] if r.get("Race") == sc_name]
        sprint_pts = defaultdict(float)
        for r in t["sprint_results"]:
            if r["raceId"] == rid:
                sprint_pts[cons[r["constructorId"]]["constructorRef"]] += float(r["points"])
        standings = {cons[r["constructorId"]]["constructorRef"]: float(r["points"]) for r in t["constructor_standings"] if r["raceId"] == rid}
        out[int(race["year"])]["rounds"].append({
            "round": int(race["round"]), "name": race["name"], "date": race["date"],
            "start_utc": f"{race['date']}T{race['time']}Z" if race.get("time") not in (None, "", "\\N") else None, "laps": max(per_lap),
            "classification": sorted([{
                "car": int(r["number"]), "code": drivers[r["driverId"]]["code"], "driver": f"{drivers[r['driverId']]['forename']} {drivers[r['driverId']]['surname']}",
                "constructor": cons[r["constructorId"]]["constructorRef"], "constructor_name": cons[r["constructorId"]]["name"],
                "grid": num(r["grid"], 0), "position_order": num(r["positionOrder"]), "position_text": r["positionText"],
                "points": float(r["points"] or 0), "laps": num(r["laps"], 0), "status": status[r["statusId"]]} for r in res],
                key=lambda x: x["position_order"]),
            "lap_positions": {str(k): v for k, v in sorted(per_lap.items())},
            "pit_stops": sorted([{"car": car[r["driverId"]], "lap": int(r["lap"]), "stop": int(r["stop"]),
                                  "duration_ms": int(r["milliseconds"]) if r["milliseconds"].isdigit() else None}
                                 for r in t["pit_stops"] if r["raceId"] == rid], key=lambda x: (x["lap"], x["car"])),
            "safety_cars": sc, "red_flags": rf,
            "sprint_points": dict(sprint_pts), "standings_after": standings,
        })
    return out


def main(seasons: list[int]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cache = Path(sys.argv[sys.argv.index("--cache") + 1]) if "--cache" in sys.argv else None
    for s, data in build(seasons, cache).items():
        path = OUT / f"{s}.json"
        path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        print(f"{s}: {len(data['rounds'])} races with lap data -> {path} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--") and not (sys.argv.index(a) > 0 and sys.argv[sys.argv.index(a) - 1] == "--cache")]
    main([int(a) for a in args] or [2023, 2024, 2026])
