"""What a running order is worth to the team, in dollars.

Two parts, kept separate because they are different kinds of money:

1. Sponsor performance bonuses: exact. Meridian's contracts (world/sponsors.json) pay per car for a win,
   podium, points finish or top six in the Grand Prix. Converted to USD at the race-day rate.
2. Championship prize money: expected. Prize money depends on where the team finishes the SEASON, so the
   value of race points is the change in expected final position. Each team's final points are modelled
   as points so far + its average points per round x rounds left, with its own round-to-round spread
   (both measured from this season's real results). The same random draws are reused for every
   evaluation within a race, so a change in dollars between laps comes only from the points that changed.

Live points use the Grand Prix scale (25-18-15-12-10-8-6-4-2-1); the fastest-lap point (2019-2024) is not
known until the end and is ignored live. Cars that have stopped are unclassified (no points) live.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from decimal import Decimal

from finance.money import to_usd
from finance.world import World

GP_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]


def points_for(pos: int | None) -> int:
    return GP_POINTS[pos - 1] if pos and pos <= len(GP_POINTS) else 0


@dataclass
class BonusLine:
    sponsor_id: str
    sponsor: str
    clause_id: str
    clause_type: str
    car: int
    position: int
    amount_orig: int  # cents, sponsor currency
    currency: str
    usd: int  # cents


@dataclass
class Valuation:
    bonuses: list[BonusLine]
    bonus_usd: int  # cents
    prize_ev: int  # cents: expected championship prize money
    positions: dict[int, float] = field(default_factory=dict)  # final constructors' position -> probability
    team_race_points: int = 0

    @property
    def total(self) -> int:
        return self.bonus_usd + self.prize_ev


class Valuer:
    def __init__(self, world: World, season: dict, rnd: int, team: str = "mercedes", sims: int = 2000, seed: int = 26):
        self.world, self.season, self.team = world, season, team
        self.race = next(r for r in season["rounds"] if r["round"] == rnd)
        self.rnd = rnd
        self.cars = {c["car"]: c for c in self.race["classification"]}
        self.team_cars = sorted(c for c, x in self.cars.items() if x["constructor"] == team)
        if not self.team_cars:
            raise ValueError(f"{team} has no cars in {season['season']} R{rnd}")
        self._fx_cache: dict[str, Decimal] = {}
        self._ev_cache: dict[tuple, tuple[int, dict]] = {}
        self._championship_model(sims, seed)

    # ------------------------------------------------------------------ sponsor bonuses (exact)

    def fx(self, currency: str) -> Decimal:
        if currency == "USD":
            return Decimal(1)
        if currency not in self._fx_cache:
            try:
                self._fx_cache[currency] = self.world.fx(currency, self.race["date"])
            except KeyError:  # beyond the synthetic rate table: use its last rate
                last = max(self.world._fx[currency])
                self._fx_cache[currency] = self.world._fx[currency][last]
        return self._fx_cache[currency]

    def bonuses(self, order: dict[int, int]) -> list[BonusLine]:
        out = []
        for sponsor in self.world.sponsors:
            contract = self.world.contract_for(sponsor["id"], self.rnd)
            for clause in contract["clauses"]:
                for car in self.team_cars:
                    pos = order.get(car)
                    if not pos:
                        continue
                    t = clause["type"]
                    hit = ((t == "win" and pos == 1) or (t == "podium" and (pos in (2, 3) if clause.get("excludes_win") else pos <= 3))
                           or (t == "points_finish" and points_for(pos) > 0) or (t == "top6" and pos <= 6))
                    if hit:
                        out.append(BonusLine(sponsor["id"], sponsor["name"], clause["id"], t, car, pos, clause["amount"], sponsor["currency"],
                                             to_usd(clause["amount"], self.fx(sponsor["currency"]))))
        return out

    # ------------------------------------------------------------------ championship prize money (expected)

    def _championship_model(self, sims: int, seed: int) -> None:
        rounds = sorted((r for r in self.season["rounds"] if r["round"] <= self.rnd), key=lambda r: r["round"])
        after = self.race["standings_after"]
        final_race_pts: dict[str, float] = {}
        for c in self.race["classification"]:
            final_race_pts[c["constructor"]] = final_race_pts.get(c["constructor"], 0) + c["points"]
        self.teams = sorted(set(after) | set(final_race_pts))
        # Points before the race started (sprint points of this weekend included).
        self.base = {t: after.get(t, 0) - final_race_pts.get(t, 0) for t in self.teams}
        # Points per round for each team, from earlier rounds this season.
        hist: dict[str, list[float]] = {t: [] for t in self.teams}
        prev: dict[str, float] = {}
        for r in rounds:
            if r["round"] >= self.rnd:
                break
            for t in self.teams:
                hist[t].append(r["standings_after"].get(t, 0) - prev.get(t, 0))
            prev = r["standings_after"]
        self.rate, self.sd = {}, {}
        for t in self.teams:
            h = hist[t]
            self.rate[t] = sum(h) / len(h) if h else 0.0
            var = sum((x - self.rate[t]) ** 2 for x in h) / (len(h) - 1) if len(h) > 2 else (max(5.0, 0.5 * self.rate[t])) ** 2
            self.sd[t] = max(2.0, math.sqrt(var))
        self.remaining = max(0, self.season.get("total_rounds", self.rnd) - self.rnd)
        rng = random.Random(f"{seed}|{self.season['season']}|{self.rnd}")
        self.draws = [[rng.gauss(0, 1) for _ in self.teams] for _ in range(sims)] if self.remaining else [[0.0] * len(self.teams)]
        table = {int(k): int(v) for k, v in __import__("json").loads((self.world.dir / "prize_table.json").read_text())["by_position"].items()}
        self.prize = lambda pos: table.get(pos, table[max(table)])

    def championship(self, race_points: dict[str, int]) -> tuple[int, dict[int, float]]:
        key = tuple(race_points.get(t, 0) for t in self.teams)
        if key in self._ev_cache:
            return self._ev_cache[key]
        idx = self.teams.index(self.team)
        sqrt_r = math.sqrt(self.remaining)
        mean = [self.base[t] + race_points.get(t, 0) + self.rate[t] * self.remaining for t in self.teams]
        total, counts = 0, {}
        for z in self.draws:
            final = [mean[i] + self.sd[t] * sqrt_r * z[i] for i, t in enumerate(self.teams)]
            mine = final[idx]
            pos = 1 + sum(1 for i, v in enumerate(final) if i != idx and (v > mine or (v == mine and i < idx)))
            total += self.prize(pos)
            counts[pos] = counts.get(pos, 0) + 1
        n = len(self.draws)
        out = (round(total / n), {p: c / n for p, c in sorted(counts.items())})
        self._ev_cache[key] = out
        return out

    # ------------------------------------------------------------------ whole valuation

    def value(self, order: dict[int, int]) -> Valuation:
        lines = self.bonuses(order)
        race_pts: dict[str, int] = {}
        for car, pos in order.items():
            t = self.cars[car]["constructor"] if car in self.cars else None
            if t:
                race_pts[t] = race_pts.get(t, 0) + points_for(pos)
        ev, dist = self.championship(race_pts)
        return Valuation(lines, sum(x.usd for x in lines), ev, dist, race_pts.get(self.team, 0))

    def swapped(self, order: dict[int, int], car: int, direction: int) -> dict[int, int] | None:
        """The order with `car` one place up (direction -1) or down (+1), swapping with whoever is there."""
        pos = order.get(car)
        if not pos:
            return None
        target = pos + direction
        other = next((c for c, p in order.items() if p == target), None)
        if other is None:
            return None
        new = dict(order)
        new[car], new[other] = target, pos
        return new
