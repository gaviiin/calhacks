"""Which constructor the fictional customer mirrors, and what that permits.

Meridian Racing's contracts, people and policies are synthetic; its on-track results mirror one real
constructor. The championship-money story runs as Mercedes (cars 63 and 44). For the crash case the
same customer can run as a Williams-mirror (cars 43, 23, 2), so the lap-32 crash is an own-team
incident with the full workflow and Mercedes' cars become competitors whose results only move our
projections. Scope is a permission: a competitor's incident never reaches our garage or cost cap desk.
"""

from __future__ import annotations

from typing import Literal

from finance.world import World

TEAMS: dict[str, dict] = {
    "mercedes": {"label": "Meridian Racing (mirrors Mercedes' 2024 results)", "short": "Meridian · Mercedes-mirror",
                 "story": "championship money: a front-runner whose stops and the weather move the sponsor clauses"},
    "alpine": {"label": "Meridian Racing as an Alpine-mirror (cars 31 and 10; same synthetic contracts)", "short": "Meridian · Alpine-mirror",
               "story": "strategy upside: a midfield car in the points, where a stop, a flag or the weather moves real clauses"},
    "williams": {"label": "Meridian Racing as a Williams-mirror (Williams' 2024 entries; same synthetic contracts)", "short": "Meridian · Williams-mirror",
                 "story": "cost risk: the lap-32 crash is our own car, so the garage, the cost cap and the approvals run"},
}

Scope = Literal["own_team", "competitor"]


class LiveWorld(World):
    """The revenue desk's world with the mirrored constructor chosen per replay."""

    def __init__(self, team: str = "mercedes", **kw):
        super().__init__(**kw)
        if team not in TEAMS:
            raise ValueError(f"unknown team {team!r}; one of {sorted(TEAMS)}")
        self._team = team

    @property
    def team(self) -> str:  # type: ignore[override]
        return self._team

    def describe(self) -> str:
        return TEAMS[self._team]["label"]


def team_cars(world: World, season: int, drivers_meta: list[dict]) -> list[int]:
    """The team's cars entered in this session (the drivers list), starters first. A car that raced
    for the constructor earlier in the season but is not on this entry list is not ours today."""
    entered = {int(d["driver_number"]) for d in drivers_meta}
    return sorted(n for n, i in world.car_map(season).items() if i["constructor_id"] == world.team and n in entered)


def scope_of(car: int | None, team_cars: list[int]) -> Scope:
    return "own_team" if car is not None and car in team_cars else "competitor"
