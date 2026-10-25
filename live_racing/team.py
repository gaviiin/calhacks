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
    "mercedes": {"label": "Meridian Racing (mirrors Mercedes' 2024 results)", "short": "Meridian · Mercedes-mirror"},
    "williams": {"label": "Meridian Racing as a Williams-mirror (cars 43, 23, 2; same synthetic contracts)", "short": "Meridian · Williams-mirror"},
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


def scope_of(car: int | None, team_cars: list[int]) -> Scope:
    return "own_team" if car is not None and car in team_cars else "competitor"
