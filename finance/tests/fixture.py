"""SYNTHETIC test season. Not real race results.

Builds a temporary world: the real sponsors, contracts, policy, FX and prize
table, plus a made-up 2024 results file with 16 rounds. Round 14 is named the
Belgian Grand Prix so the real FIA capture for Spa 2024 drives its timing, and
car 63 is disqualified there after crossing the line first, as it was in reality.
"""

from __future__ import annotations

import json
import random
import shutil
from datetime import date, timedelta
from pathlib import Path

from finance.config import GP_POINTS, POLICY_DIR, SPRINT_POINTS, WORLD_DIR
from finance.world import World

TEAMS = [("mercedes", [44, 63]), ("red_bull", [1, 11]), ("mclaren", [4, 81]), ("ferrari", [16, 55]),
         ("aston_martin", [14, 18]), ("alpine", [10, 31]), ("williams", [23, 2]), ("rb", [22, 3]),
         ("sauber", [77, 24]), ("haas", [27, 20])]
DRIVER = {44: "hamilton", 63: "russell"}
SPRINTS = {5, 10}
# Mercedes finishing positions we need for specific tests: (round, session) -> {car: position}
FORCED = {
    (2, "race"): {44: 1, 63: 4},  # a win and a P4
    (5, "sprint"): {63: 3, 44: 7},  # sprint podium + sprint points
    (5, "race"): {63: 2, 44: 6},
    (10, "sprint"): {44: 5, 63: 9},
    (12, "race"): {44: 3, 63: 5},  # podium after the Halcyon amendment
    (14, "race"): {63: 1, 44: 2},  # road positions; 63 is disqualified in the final classification
}


def _classification(rng: random.Random, rnd: int, session: str) -> list[dict]:
    cars = [(c, team) for team, cs in TEAMS for c in cs]
    forced = FORCED.get((rnd, session), {})
    others = [x for x in cars if x[0] not in forced]
    rng.shuffle(others)
    if not forced:
        # keep Mercedes mid-pack by default so the championship gap stays interesting
        merc = [x for x in others if x[1] == "mercedes"]
        rest = [x for x in others if x[1] != "mercedes"]
        order = rest[:5] + merc + rest[5:]
    else:
        order = [None] * len(cars)
        for car, pos in forced.items():
            order[pos - 1] = (car, "mercedes")
        it = iter(others)
        order = [x if x is not None else next(it) for x in order]
    table = GP_POINTS if session == "race" else SPRINT_POINTS
    rows = []
    for i, (car, team) in enumerate(order):
        pos = i + 1
        rows.append({"number": car, "driver_id": DRIVER.get(car, f"driver{car}"), "code": f"D{car:02d}", "constructor_id": team,
                     "position": pos, "position_text": str(pos), "status": "Finished",
                     "points": float(table[i]) if i < len(table) else 0.0, "grid": pos})
    return rows


def _disqualify_final(rows: list[dict], car: int) -> list[dict]:
    target = next(r for r in rows if r["number"] == car)
    out = [r for r in rows if r["number"] != car]
    for i, r in enumerate(out):
        r["position"], r["position_text"] = i + 1, str(i + 1)
        r["points"] = float(GP_POINTS[i]) if i < len(GP_POINTS) else 0.0
    out.append({**target, "position": len(out) + 1, "position_text": "D", "status": "Disqualified", "points": 0.0})
    return out


def build(tmp: Path) -> World:
    world_dir = tmp / "world"
    shutil.copytree(WORLD_DIR, world_dir, ignore=shutil.ignore_patterns("results", "requests"))
    rng = random.Random(42)
    rounds = []
    for n in range(1, 17):
        name = "Belgian Grand Prix" if n == 14 else f"Fixture Grand Prix {n}"
        slug = "belgian-grand-prix" if n == 14 else f"fixture-grand-prix-{n}"
        d = (date(2024, 3, 3) + timedelta(days=10 * (n - 1))).isoformat() if n < 14 else (
            date(2024, 7, 28) + timedelta(days=14 * (n - 14))).isoformat()
        race = _classification(rng, n, "race")
        if n == 14:
            race = _disqualify_final(race, 63)
        rounds.append({"round": n, "name": name, "slug": slug, "date": d, "time": "13:00:00Z",
                       "has_sprint": n in SPRINTS, "sprint_date": None, "sprint_time": None,
                       "race": race if n <= 14 else [], "sprint": _classification(rng, n, "sprint") if n in SPRINTS else []})
    (world_dir / "results").mkdir()
    (world_dir / "results" / "2024.json").write_text(json.dumps(
        {"season": 2024, "source": "SYNTHETIC test fixture", "rounds": rounds}))
    (world_dir / "result_changes.json").write_text(json.dumps({"changes": [
        {"season": 2024, "round": 14, "slug": "belgian-grand-prix", "session": "race", "car": 63, "driver_id": "russell",
         "road_position": 1, "final_status": "DSQ", "verified": True}]}))
    return World(world_dir, POLICY_DIR)
