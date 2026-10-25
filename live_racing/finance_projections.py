"""Indicative sponsor arithmetic for a classification that has not happened yet (plan section 5).

"If the race ended now": the current positions are run through the revenue desk's own contract
logic (`finance.bonuses.bonuses_for`, the same function the kernel re-performs entries with), so
the figures are exactly what the desk would book if those positions were the final classification.
They are unbooked exposure under synthetic contracts, labelled `indicative`. No ledger writes.

Not modelled on purpose: fastest-lap points, probabilities of positions changing, netting against
the FIA cost cap (sporting results do not change cost-cap expenses).
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable

from finance.bonuses import bonuses_for
from finance.config import GP_POINTS
from finance.world import Row, World

from .races import Race
from .schemas import ChampionshipContext, Forecast, ForecastChange, ForecastLine, PrizeIfFinishedNow


def usd(cents: int | None) -> str:
    if cents is None:
        return "unknown"
    sign = "-" if cents < 0 else ""
    c = abs(cents)
    if c >= 100_000_000:
        return f"{sign}${c / 100_000_000:.2f}M"
    if c >= 100_000:
        return f"{sign}${c / 100_000:.0f}k"
    return f"{sign}${c / 100:,.2f}"


def _slug(team_name: str | None) -> str:
    return (team_name or "unknown").lower().replace(" ", "_")


def rows_from_positions(world: World, season: int, positions: dict[int, int | None], drivers_meta: Iterable[dict] | None = None) -> list[Row]:
    """Classification rows for every car with a known position. Constructors come from the season's
    real car map (world/results); an unknown car falls back to the OpenF1 team name."""
    car_map = world.car_map(season)
    teams = {int(d["driver_number"]): d.get("team_name") for d in (drivers_meta or [])}
    rows = []
    for number, pos in positions.items():
        if pos is None:
            continue
        info = car_map.get(number, {})
        points = float(GP_POINTS[pos - 1]) if 1 <= pos <= len(GP_POINTS) else 0.0
        rows.append(Row(number=number, driver_id=info.get("driver_id", f"car{number}"), code=info.get("code", ""),
                        constructor_id=info.get("constructor_id", _slug(teams.get(number))), pos=pos, pos_text=str(pos),
                        status="running", points=points))
    return sorted(rows, key=lambda r: r.pos or 99)


def _usd_cents(amount_cents: int, currency: str, world: World, on: str) -> tuple[int, str]:
    rate = world.fx(currency, on)
    return int((Decimal(amount_cents) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP)), str(rate)


def forecast_for_rows(world: World, race: Race, rows: list[Row], *, as_of_utc: str | None, type: str = "if_finished_now",
                      status: str = "indicative", basis: str = "") -> Forecast:
    lines, _ambiguities = bonuses_for(world, race.season, race.round, "race", rows, {})
    out: list[ForecastLine] = []
    for line in lines:
        usd_cents, rate = _usd_cents(line.amount_orig, line.currency, world, race.sporting_source_date)
        out.append(ForecastLine(sponsor_id=line.sponsor_id, sponsor_name=world.sponsor(line.sponsor_id)["name"], contract_ref=line.contract_ref,
                                clause_id=line.clause_id, clause_type=line.clause_type, car=line.car, driver_id=line.driver_id,
                                position=line.position, amount_orig_cents=line.amount_orig, currency=line.currency, fx_rate=rate,
                                amount_usd_cents=usd_cents, quote=line.quote))
    out.sort(key=lambda l: (-l.amount_usd_cents, l.sponsor_id, l.car))
    prize = _prize(world, race, rows)
    team_rows = world.team_rows(rows)
    team_text = ", ".join(f"car {r.number} P{r.pos}" for r in team_rows) or "team cars unclassified"
    return Forecast(type=type, status=status, amount_cents=sum(l.amount_usd_cents for l in out), lines=out, prize=prize,
                    basis=basis or f"positions as of {as_of_utc}: {team_text}", as_of_utc=as_of_utc)


def _prize(world: World, race: Race, rows: list[Row]) -> PrizeIfFinishedNow | None:
    """Constructors' position if these positions stood, on top of the real standings through the
    previous round. The prize table is synthetic; the position is a count, not a forecast."""
    try:
        standings = dict(world.standings(race.season, race.round - 1))
    except KeyError:
        return None
    for r in rows:
        standings[r.constructor_id] = standings.get(r.constructor_id, 0.0) + r.points
    table = sorted(standings.items(), key=lambda kv: (-kv[1], kv[0]))
    names = [c for c, _ in table]
    if world.team not in names:
        return None
    pos = names.index(world.team) + 1
    return PrizeIfFinishedNow(constructors_position=pos, points=standings[world.team], prize_table_cents=world.prize(pos),
                              note=f"P{pos} in the constructors' standings if this result stood (through R{race.round - 1} plus these positions); "
                              "synthetic prize table, indicative only")


def championship_context(world: World, race: Race, positions: dict[int, int | None], drivers_meta: Iterable[dict] | None = None) -> ChampionshipContext | None:
    """The constructors' table if this running order were the result: our place, the gap to the teams
    either side, and what one place in the table is worth on the (synthetic) prize table."""
    rows = rows_from_positions(world, race.season, positions, drivers_meta)
    try:
        standings = dict(world.standings(race.season, race.round - 1))
    except KeyError:
        return None
    ours = 0.0
    for r in rows:
        standings[r.constructor_id] = standings.get(r.constructor_id, 0.0) + r.points
        if r.constructor_id == world.team:
            ours += r.points
    table = sorted(standings.items(), key=lambda kv: (-kv[1], kv[0]))
    names = [c for c, _ in table]
    if world.team not in names:
        return None
    i = names.index(world.team)
    pts = standings[world.team]
    above = table[i - 1] if i > 0 else None
    below = table[i + 1] if i + 1 < len(table) else None
    prize = world.prize(i + 1)
    return ChampionshipContext(
        position=i + 1, points=pts, prize_cents=prize, points_this_race=ours,
        above_team=above[0] if above else None, above_gap_points=round(above[1] - pts, 1) if above else None,
        prize_up_one_cents=(world.prize(i) - prize) if above else None,
        below_team=below[0] if below else None, below_gap_points=round(pts - below[1], 1) if below else None,
        prize_down_one_cents=(world.prize(i + 2) - prize) if below else None,
        note=f"standings through R{race.round - 1} (real) plus these positions; the prize table is synthetic and pays at the season's end")


def if_finished_now(world: World, race: Race, positions: dict[int, int | None], *, as_of_utc: str | None,
                    drivers_meta: Iterable[dict] | None = None) -> Forecast:
    rows = rows_from_positions(world, race.season, positions, drivers_meta)
    return forecast_for_rows(world, race, rows, as_of_utc=as_of_utc)


def _key(l: ForecastLine) -> str:
    return f"{l.sponsor_name} clause {l.clause_id} {l.clause_type} (car {l.car}, {usd(l.amount_usd_cents)})"


def diff(before: Forecast | None, after: Forecast) -> ForecastChange:
    b_keys = {_key(l) for l in before.lines} if before else set()
    a_keys = {_key(l) for l in after.lines}
    before_cents = before.amount_cents if before else None
    delta = None if before_cents is None else (after.amount_cents or 0) - before_cents
    gained, lost = sorted(a_keys - b_keys), sorted(b_keys - a_keys)
    parts = []
    if gained:
        parts.append("gained " + "; ".join(gained))
    if lost:
        parts.append("lost " + "; ".join(lost))
    text = (f"Expected sponsor bonuses if the race ended now: {usd(before_cents)} -> {usd(after.amount_cents)}"
            + (f" ({'+' if (delta or 0) >= 0 else ''}{usd(delta)})" if delta is not None else "")
            + (": " + ". ".join(parts) if parts else "") + ". Indicative, unbooked.")
    return ForecastChange(before_cents=before_cents, after_cents=after.amount_cents, delta_cents=delta, gained=gained, lost=lost, text=text)
