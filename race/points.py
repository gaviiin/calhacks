"""Championship points and the projected constructors' order."""

from __future__ import annotations

RACE_POINTS = {1: 25, 2: 18, 3: 15, 4: 12, 5: 10, 6: 8, 7: 6, 8: 4, 9: 2, 10: 1}
SPRINT_POINTS = {1: 8, 2: 7, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1}


def points_for(position: int | None, sprint: bool = False) -> int:
    if not position:
        return 0
    return (SPRINT_POINTS if sprint else RACE_POINTS).get(position, 0)


def projected_standings(points_start: dict[str, float], positions: dict[int, int | None], team_of: dict[int, str],
                        sprint: bool = False) -> list[tuple[str, float]]:
    """Teams ordered by points_start + points implied by the current running order. Retired cars score 0."""
    pts = dict(points_start)
    for car, pos in positions.items():
        team = team_of.get(car)
        if team is None:
            continue
        pts[team] = pts.get(team, 0.0) + points_for(pos, sprint)
    return sorted(pts.items(), key=lambda kv: (-kv[1], kv[0]))


def position_of(team: str, standings: list[tuple[str, float]]) -> int | None:
    for i, (t, _) in enumerate(standings, start=1):
        if t == team:
            return i
    return None
