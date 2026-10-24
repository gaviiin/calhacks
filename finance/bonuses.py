"""Which sponsor bonuses a classification earns, under the contract version in effect.

Pure function shared by the engine (to propose entries) and the kernel (to
re-perform them, check K4). The grader uses its own independent calculation.
"""

from __future__ import annotations

from dataclasses import dataclass

from .world import Row, World


@dataclass(frozen=True)
class BonusLine:
    sponsor_id: str
    contract_ref: str
    clause_id: str
    clause_type: str
    season: int
    round: int
    session: str  # 'race' | 'sprint'
    car: int
    driver_id: str
    position: int | None
    amount_orig: int
    currency: str
    quote: str

    @property
    def key(self) -> str:
        return bonus_key(self.season, self.round, self.session, self.sponsor_id, self.clause_id, self.car)


@dataclass(frozen=True)
class Ambiguity:
    sponsor_id: str
    contract_ref: str
    clause_id: str
    season: int
    round: int
    session: str
    car: int
    driver_id: str
    question: str
    rule_hint: str  # rule id a controller ruling would create
    line: BonusLine  # the bonus if the clause were read to include it


def bonus_key(season: int, rnd: int, session: str, sponsor_id: str, clause_id: str, car: int) -> str:
    return f"bonus|{season}|R{rnd}|{session}|{sponsor_id}|{clause_id}|car{car}"


def _qualifies(clause: dict, row: Row) -> bool:
    t = clause["type"]
    if row.pos is None:
        return False
    if t == "win":
        return row.pos == 1
    if t == "podium":
        return (2 <= row.pos <= 3) if clause.get("excludes_win") else row.pos <= 3
    if t == "points_finish":
        return row.points > 0
    if t == "top6":
        return row.pos <= 6
    raise ValueError(f"unknown clause type {t}")


def bonuses_for(world: World, season: int, rnd: int, session: str, rows: list[Row],
                rules: dict[str, str] | None = None) -> tuple[list[BonusLine], list[Ambiguity]]:
    """Return (earned bonus lines, open ambiguities). `rules` maps rule id -> 'include'|'exclude'."""
    rules = rules or {}
    lines: list[BonusLine] = []
    open_q: list[Ambiguity] = []
    for sponsor in world.sponsors:
        contract = world.contract_for(sponsor["id"], rnd)
        for clause in contract["clauses"]:
            scope = clause["scope"]
            if session == "sprint" and scope == "grand_prix":
                continue
            for row in world.team_rows(rows):
                if not _qualifies(clause, row):
                    continue
                line = BonusLine(
                    sponsor_id=sponsor["id"], contract_ref=contract["contract_ref"], clause_id=clause["id"],
                    clause_type=clause["type"], season=season, round=rnd, session=session, car=row.number,
                    driver_id=row.driver_id, position=row.pos, amount_orig=int(clause["amount"]),
                    currency=sponsor["currency"], quote=clause["quote"],
                )
                if session == "sprint" and scope == "ambiguous":
                    rule_id = f"{sponsor['id'].upper()}-SPRINT-01"
                    ruling = rules.get(rule_id)
                    if ruling == "include":
                        lines.append(line)
                    elif ruling is None:
                        open_q.append(Ambiguity(
                            sponsor_id=sponsor["id"], contract_ref=contract["contract_ref"], clause_id=clause["id"],
                            season=season, round=rnd, session=session, car=row.number, driver_id=row.driver_id,
                            question=(f"{sponsor['name']} clause {clause['id']} pays for \"each points finish\" but does not say "
                                      f"whether sprint races count. Car {row.number} ({row.driver_id}) scored points in the "
                                      f"R{rnd} sprint. Does the clause include sprints?"),
                            rule_hint=rule_id, line=line,
                        ))
                    continue
                lines.append(line)
    return lines, open_q
