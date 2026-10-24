"""Read-only view of Meridian Racing's world: results, contracts, FX, prize table, policy.

Everything here comes from files under world/ and policy/. Nothing in this
module writes. Classifications come in three versions:

- "final": as published (the cached Jolpica-F1 results), plus any scenario
  overlays (a stewards' decision a judge applies live);
- "provisional": the race-day classification, rebuilt from the final one by
  putting a later-disqualified car back at its road position
  (world/result_changes.json).
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from functools import cached_property
from pathlib import Path

from .config import DSQ_TEXTS, GP_POINTS, POLICY_DIR, SPRINT_POINTS, WORLD_DIR


@dataclass(frozen=True)
class Row:
    number: int
    driver_id: str
    code: str
    constructor_id: str
    pos: int | None  # classified position, None if not classified
    pos_text: str
    status: str
    points: float


def _row(raw: dict) -> Row:
    text = str(raw.get("position_text", ""))
    pos = int(text) if text.isdigit() else None
    return Row(
        number=int(raw["number"]),
        driver_id=raw["driver_id"],
        code=raw.get("code", ""),
        constructor_id=raw["constructor_id"],
        pos=pos,
        pos_text=text,
        status=raw.get("status", ""),
        points=float(raw.get("points", 0)),
    )


def _reaward(rows: list[Row], session: str) -> list[Row]:
    """Recompute points from positions (fastest-lap points are not modelled)."""
    table = GP_POINTS if session == "race" else SPRINT_POINTS
    out = []
    for r in rows:
        pts = table[r.pos - 1] if r.pos is not None and r.pos <= len(table) else 0
        out.append(Row(r.number, r.driver_id, r.code, r.constructor_id, r.pos, r.pos_text, r.status, float(pts)))
    return out


def _sort(rows: list[Row]) -> list[Row]:
    return sorted(rows, key=lambda r: (r.pos is None, r.pos or 999, r.number))


def disqualify(rows: list[Row], car: int, session: str) -> list[Row]:
    """Remove a car from the classification; cars behind it move up one place."""
    target = next((r for r in rows if r.number == car), None)
    if target is None:
        raise ValueError(f"car {car} not in classification")
    old = target.pos
    out = []
    for r in rows:
        if r.number == car:
            out.append(Row(r.number, r.driver_id, r.code, r.constructor_id, None, "D", "Disqualified", 0.0))
        elif old is not None and r.pos is not None and r.pos > old:
            out.append(Row(r.number, r.driver_id, r.code, r.constructor_id, r.pos - 1, str(r.pos - 1), r.status, r.points))
        else:
            out.append(r)
    return _sort(_reaward(out, session))


def drop_positions(rows: list[Row], car: int, places: int, session: str) -> list[Row]:
    """Move a classified car `places` positions down (a time penalty, simplified)."""
    target = next((r for r in rows if r.number == car), None)
    if target is None or target.pos is None:
        raise ValueError(f"car {car} not classified")
    classified = [r for r in _sort(rows) if r.pos is not None]
    others = [r for r in rows if r.pos is None]
    order = [r for r in classified if r.number != car]
    new_index = min(target.pos - 1 + places, len(order))
    order.insert(new_index, target)
    out = [Row(r.number, r.driver_id, r.code, r.constructor_id, i + 1, str(i + 1), r.status, r.points) for i, r in enumerate(order)]
    return _sort(_reaward(out + others, session))


def reinstate(rows: list[Row], car: int, road_position: int, session: str) -> list[Row]:
    """Put a disqualified car back at its road position (the provisional classification)."""
    target = next((r for r in rows if r.number == car), None)
    if target is None:
        raise ValueError(f"car {car} not in classification")
    out = []
    for r in rows:
        if r.number == car:
            out.append(Row(r.number, r.driver_id, r.code, r.constructor_id, road_position, str(road_position), "Finished", 0.0))
        elif r.pos is not None and r.pos >= road_position:
            out.append(Row(r.number, r.driver_id, r.code, r.constructor_id, r.pos + 1, str(r.pos + 1), r.status, r.points))
        else:
            out.append(r)
    return _sort(_reaward(out, session))


class World:
    def __init__(self, world_dir: Path = WORLD_DIR, policy_dir: Path = POLICY_DIR, results_dir: Path | None = None):
        self.dir = Path(world_dir)
        self.policy_dir = Path(policy_dir)
        self.results_dir = Path(results_dir) if results_dir else self.dir / "results"

    # ------------------------------------------------------------------ config

    @cached_property
    def meridian(self) -> dict:
        return json.loads((self.dir / "meridian.json").read_text())

    @property
    def team(self) -> str:
        return self.meridian["mirrors_constructor_id"]

    @cached_property
    def _sponsor_file(self) -> dict:
        return json.loads((self.dir / "sponsors.json").read_text())

    @property
    def sponsors(self) -> list[dict]:
        return self._sponsor_file["sponsors"]

    def sponsor(self, sponsor_id: str) -> dict:
        for s in self.sponsors:
            if s["id"] == sponsor_id:
                return s
        raise KeyError(sponsor_id)

    def contract_for(self, sponsor_id: str, rnd: int) -> dict:
        versions = [c for c in self.sponsor(sponsor_id)["contracts"] if c["effective_from_round"] <= rnd]
        return max(versions, key=lambda c: c["version"])

    def contract_by_ref(self, ref: str) -> dict:
        for s in self.sponsors:
            for c in s["contracts"]:
                if c["contract_ref"] == ref:
                    return {**c, "sponsor_id": s["id"]}
        raise KeyError(ref)

    def contract_text(self, ref: str) -> str:
        name = "halcyon_v2_amendment.md" if ref == "halcyon_v2" else f"{ref}.md"
        return (self.dir / "contracts" / name).read_text()

    def policy_text(self) -> str:
        return (self.policy_dir / "revenue_policy.md").read_text()

    def policy_ids(self) -> set[str]:
        import re

        return set(re.findall(r"\bREV-\d{2}a?\b", self.policy_text()))

    @cached_property
    def prize_table(self) -> dict[int, int]:
        data = json.loads((self.dir / "prize_table.json").read_text())
        return {int(k): int(v) for k, v in data["by_position"].items()}

    def prize(self, position: int) -> int:
        return self.prize_table[min(max(position, 1), max(self.prize_table))]

    # ------------------------------------------------------------------ FX

    @cached_property
    def _fx(self) -> dict[str, dict[str, Decimal]]:
        out: dict[str, dict[str, Decimal]] = {"EUR": {}, "GBP": {}}
        with (self.dir / "fx_rates.csv").open() as fh:
            for row in csv.DictReader(fh):
                out["EUR"][row["date"]] = Decimal(row["EURUSD"])
                out["GBP"][row["date"]] = Decimal(row["GBPUSD"])
        return out

    def fx(self, currency: str, on: str) -> Decimal:
        """USD per unit of currency on a date (YYYY-MM-DD), using the latest earlier rate if missing."""
        if currency == "USD":
            return Decimal("1")
        table = self._fx[currency]
        d = date.fromisoformat(on[:10])
        for _ in range(10):
            if d.isoformat() in table:
                return table[d.isoformat()]
            d -= timedelta(days=1)
        raise KeyError(f"no {currency} rate on or before {on}")

    # ------------------------------------------------------------------ results

    @cached_property
    def _seasons(self) -> dict[int, dict]:
        out = {}
        for path in sorted(self.results_dir.glob("*.json")):
            data = json.loads(path.read_text())
            out[int(data["season"])] = data
        return out

    def seasons(self) -> list[int]:
        return sorted(self._seasons)

    def rounds(self, season: int) -> list[dict]:
        return [r for r in self._seasons[season]["rounds"] if r.get("race")]

    def round(self, season: int, rnd: int) -> dict:
        for r in self._seasons[season]["rounds"]:
            if int(r["round"]) == rnd:
                return r
        raise KeyError(f"{season} R{rnd}")

    def gp_rounds_in_season(self, season: int) -> int:
        return len(self._seasons[season]["rounds"])

    def race_start(self, season: int, rnd: int, session: str = "race") -> datetime:
        r = self.round(season, rnd)
        if session == "sprint":
            d = r.get("sprint_date") or (date.fromisoformat(r["date"]) - timedelta(days=1)).isoformat()
            t = r.get("sprint_time") or "15:00:00Z"
        else:
            d, t = r["date"], r.get("time") or "13:00:00Z"
        return datetime.fromisoformat(f"{d}T{t.replace('Z', '')}+00:00")

    @cached_property
    def result_changes(self) -> list[dict]:
        path = self.dir / "result_changes.json"
        return json.loads(path.read_text())["changes"] if path.exists() else []

    def changes_for(self, season: int, slug: str, session: str) -> list[dict]:
        return [c for c in self.result_changes if c["season"] == season and c["slug"] == slug and c["session"] == session]

    def classification(self, season: int, rnd: int, session: str = "race", version: str = "final",
                       overlays: list[dict] | None = None) -> list[Row]:
        r = self.round(season, rnd)
        rows = _sort([_row(x) for x in r.get(session, [])])
        if version == "provisional":
            for change in sorted(self.changes_for(season, r["slug"], session), key=lambda c: c["road_position"]):
                car = next((x for x in rows if x.number == change["car"]), None)
                if car is not None and car.pos_text in DSQ_TEXTS:
                    rows = reinstate(rows, change["car"], change["road_position"], session)
            return rows
        for ov in overlays or []:
            if ov["season"] == season and ov["round"] == rnd and ov.get("session", "race") == session:
                if ov["action"] == "dsq":
                    rows = disqualify(rows, ov["car"], session)
                elif ov["action"] == "drop":
                    rows = drop_positions(rows, ov["car"], int(ov["places"]), session)
        return rows

    def team_rows(self, rows: list[Row]) -> list[Row]:
        return [r for r in rows if r.constructor_id == self.team]

    def car_map(self, season: int) -> dict[int, dict]:
        out = {}
        for rnd in self._seasons[season]["rounds"]:
            for r in rnd.get("race", []) + rnd.get("sprint", []):
                out[int(r["number"])] = {"driver_id": r["driver_id"], "code": r.get("code", ""), "constructor_id": r["constructor_id"]}
        return out

    def standings(self, season: int, through_round: int, overlays: list[dict] | None = None) -> list[tuple[str, float]]:
        """Constructors' points after `through_round` (final results + overlays), best first."""
        pts: dict[str, float] = {}
        for rnd in self.rounds(season):
            n = int(rnd["round"])
            if n > through_round:
                continue
            for session in ("race", "sprint"):
                if not rnd.get(session):
                    continue
                for row in self.classification(season, n, session, "final", overlays):
                    pts[row.constructor_id] = pts.get(row.constructor_id, 0.0) + row.points
        return sorted(pts.items(), key=lambda kv: (-kv[1], kv[0]))

    def prize_estimate(self, season: int, through_round: int, overlays: list[dict] | None = None) -> tuple[int, int, str]:
        """REV-03: (estimated position, estimated total prize cents, explanation)."""
        table = self.standings(season, through_round, overlays)
        names = [c for c, _ in table]
        if self.team not in names:
            return 10, self.prize(10), "team not classified yet; lowest position assumed"
        i = names.index(self.team)
        pos = i + 1
        all_final = through_round >= self.gp_rounds_in_season(season)
        if not all_final and i + 1 < len(table) and table[i][1] - table[i + 1][1] < 10:
            gap = table[i][1] - table[i + 1][1]
            return pos + 1, self.prize(pos + 1), f"P{pos} on {table[i][1]:g} pts, only {gap:g} ahead of {table[i + 1][0]}; constrained to P{pos + 1}"
        why = f"P{pos} on {table[i][1]:g} pts" + (" (season complete)" if all_final else "")
        return pos, self.prize(pos), why
