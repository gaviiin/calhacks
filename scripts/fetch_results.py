"""Fetch real F1 results from the Jolpica-F1 API (Ergast successor) and cache them.

    python scripts/fetch_results.py 2023 2024

Writes world/results/<season>.json in the shape finance/world.py reads.
Run it on a laptop with normal internet; the finance code only ever reads the cache,
so the demo works offline afterwards.

Also prints every disqualification of a car from the mirrored constructor, as
candidates for world/result_changes.json (you still need each car's road position).
"""

from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import Request, urlopen

BASE = "https://api.jolpi.ca/ergast/f1"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "world" / "results"
MERIDIAN = json.loads((ROOT / "world" / "meridian.json").read_text())


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def get(path: str) -> dict:
    for attempt in range(5):
        try:
            req = Request(f"{BASE}/{path}", headers={"User-Agent": "pit-wall-hackathon"})
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            time.sleep(0.35)  # stay under the public rate limit
            return data["MRData"]
        except Exception as exc:  # noqa: BLE001
            if attempt == 4:
                raise
            print(f"  retry {path}: {exc}")
            time.sleep(2 + attempt * 2)
    raise AssertionError


def paged(path: str, key: str) -> list[dict]:
    races: dict[str, dict] = {}
    offset = 0
    while True:
        data = get(f"{path}?limit=100&offset={offset}")
        for race in data["RaceTable"]["Races"]:
            merged = races.setdefault(race["round"], {**race, key: []})
            merged[key].extend(race.get(key, []))
        offset += 100
        if offset >= int(data["total"]):
            return list(races.values())


def row(result: dict) -> dict:
    return {
        "number": int(result.get("number") or result["Driver"].get("permanentNumber") or 0),
        "driver_id": result["Driver"]["driverId"],
        "code": result["Driver"].get("code", ""),
        "constructor_id": result["Constructor"]["constructorId"],
        "position": int(result["position"]),
        "position_text": result["positionText"],
        "status": result.get("status", ""),
        "points": float(result.get("points", 0)),
        "grid": int(result.get("grid") or 0),
    }


def fetch(season: int) -> dict:
    schedule = get(f"{season}/races/?limit=100")["RaceTable"]["Races"]
    results = {r["round"]: r for r in paged(f"{season}/results/", "Results")}
    sprints = {r["round"]: r for r in paged(f"{season}/sprint/", "SprintResults")}
    rounds = []
    for race in schedule:
        rnd = race["round"]
        rounds.append(
            {
                "round": int(rnd),
                "name": race["raceName"],
                "slug": slugify(race["raceName"]),
                "date": race["date"],
                "time": race.get("time", "13:00:00Z"),
                "has_sprint": rnd in sprints,
                "sprint_date": race.get("Sprint", {}).get("date"),
                "sprint_time": race.get("Sprint", {}).get("time"),
                "race": [row(r) for r in results.get(rnd, {}).get("Results", [])],
                "sprint": [row(r) for r in sprints.get(rnd, {}).get("SprintResults", [])],
            }
        )
    return {
        "season": season,
        "source": "jolpica-f1 (Ergast-compatible API), https://api.jolpi.ca",
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "rounds": rounds,
    }


def main(seasons: list[int]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    team = MERIDIAN["mirrors_constructor_id"]
    for season in seasons:
        print(f"Fetching {season} ...")
        data = fetch(season)
        (OUT / f"{season}.json").write_text(json.dumps(data, indent=1) + "\n")
        done = sum(1 for r in data["rounds"] if r["race"])
        print(f"  {len(data['rounds'])} rounds ({done} with results) -> world/results/{season}.json")
        for rnd in data["rounds"]:
            for session in ("race", "sprint"):
                for r in rnd[session]:
                    if r["constructor_id"] == team and (r["position_text"] == "D" or r["status"].lower().startswith("disqualified")):
                        print(f"  DSQ candidate: {season} R{rnd['round']} {rnd['slug']} {session} car {r['number']} {r['driver_id']}")


if __name__ == "__main__":
    main([int(s) for s in sys.argv[1:]] or [MERIDIAN["train_season"], MERIDIAN["test_season"]])
