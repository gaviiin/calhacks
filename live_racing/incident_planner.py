"""Accident outcomes, priced: retire, repair and rejoin, the usual penalties, disqualification.

Each scenario is the same if-finished-now arithmetic on a different running order, so the pit wall
sees what each choice does to the sponsor exposure and the constructors' position before anyone
has to decide. The cost side (parts, the cap) is not guessed: it waits for the garage report and
the cost cap desk's valuation (plan 6C).
"""

from __future__ import annotations

from finance.world import World

from .finance_projections import diff, if_finished_now, usd
from .race_state import RaceState
from .races import Race
from .schemas import AdvisorNote, IncidentPlan, IncidentScenario, IncidentSignal, Timestamps
from .strategy import cars_behind_within, effective_pit_loss, positions_after_losing, positions_without

REPAIR_STOP_S = 90.0  # a nose change and a check in the box: an assumption, stated on the scenario
DRIVE_THROUGH_S = 20.0

COST_CAP_NOTE = ("Replacement parts after accident damage are Relevant Costs under the FIA Financial Regulations (no exclusion for crash "
                 "damage); their value is unknown until the garage report and the cost cap desk's valuation (hand-off requested). "
                 "Nothing here changes the cap or books a cost.")


def _scenario(world: World, race: Race, base, positions_after: dict, key: str, label: str, assumption: str, car: int, as_of, drivers_meta) -> IncidentScenario:
    fc = if_finished_now(world, race, positions_after, as_of_utc=as_of, drivers_meta=drivers_meta)
    d = diff(base, fc)
    prize_before = base.prize.prize_table_cents if base.prize else 0
    prize_after = fc.prize.prize_table_cents if fc.prize else 0
    return IncidentScenario(key=key, label=label, assumption=assumption, position_after=positions_after.get(car), exposure_after_cents=fc.amount_cents or 0,
                            delta_cents=(fc.amount_cents or 0) - (base.amount_cents or 0), lines_lost=d.lost, lines_gained=d.gained,
                            constructors_position_after=fc.prize.constructors_position if fc.prize else None, prize_delta_cents=prize_after - prize_before)


def gate(scen: list[IncidentScenario], car_status: str, flag: str | None) -> list[IncidentScenario]:
    """The feasibility gate. A stationary car cannot continue, pit or serve a penalty; a repair needs
    engineering clearance whatever the flag; a red-flag stop saves track position, not money, and
    proves nothing about whether the car can be repaired."""
    stopped = car_status in ("stopped_candidate", "retired")  # a car the timing feed shows out cannot continue either
    for s in scen:
        if s.key in ("continue", "pit_now", "penalty_5s", "penalty_10s", "drive_through") and stopped:
            s.feasible, s.why = False, "the car is stationary; it cannot continue, pit or serve a penalty"
        elif s.key == "repair_and_rejoin":
            s.requires = ["engineering_clearance"]
            if stopped:
                s.feasible, s.why = False, "only if the garage reports the car repairable and engineering clears it; a red flag frees track position, not the parts cost"
            else:
                s.why = "a repair commits parts cost (Relevant Costs) and needs engineering clearance; the position arithmetic is not the decision"
        elif s.key == "disqualified":
            s.requires = ["stewards_decision"]
            s.why = "a stewards' decision after the race, not a team choice"
        elif s.key == "retire" and stopped:
            s.why = "the likely outcome for a stationary car; costs nothing further on the sponsor side"
    return scen


def scenarios_for(world: World, race: Race, state: RaceState, car: int, as_of: str | None, drivers_meta) -> list[IncidentScenario]:
    positions = state.positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    pos = positions.get(car)
    out = [_scenario(world, race, base, positions, "continue", "Continue as is", "the car keeps its current position", car, as_of, drivers_meta)]
    loss, basis, under = effective_pit_loss(state)
    if pos is not None:
        passed, _ = cars_behind_within(state, car, loss) if loss > 0 else ([], [])
        out.append(_scenario(world, race, base, positions_after_losing(positions, car, len(passed)), "pit_now", "Pit now",
                             f"about {loss:.0f}s in the lane ({basis}); {len(passed)} car(s) get past", car, as_of, drivers_meta))
        if state.flag_status == "RED_FLAG":
            out.append(_scenario(world, race, base, positions, "repair_and_rejoin", "Repair under the red flag and rejoin",
                                 "repairs are allowed while the race is suspended; the position is kept", car, as_of, drivers_meta))
        else:
            passed_r, _ = cars_behind_within(state, car, REPAIR_STOP_S)
            out.append(_scenario(world, race, base, positions_after_losing(positions, car, len(passed_r)), "repair_and_rejoin", "Pit, repair and rejoin",
                                 f"about {REPAIR_STOP_S:.0f}s stationary for a nose change and a check (assumption); {len(passed_r)} car(s) get past", car, as_of, drivers_meta))
        for key, secs, label in (("penalty_5s", 5.0, "5-second time penalty"), ("penalty_10s", 10.0, "10-second time penalty"),
                                 ("drive_through", DRIVE_THROUGH_S, "Drive-through penalty")):
            passed_p, _ = cars_behind_within(state, car, secs)
            out.append(_scenario(world, race, base, positions_after_losing(positions, car, len(passed_p)), key, label,
                                 f"{secs:.0f}s lost at the line against the cars behind now; {len(passed_p)} car(s) get past", car, as_of, drivers_meta))
    out.append(_scenario(world, race, base, positions_without(positions, car), "retire", "Retire the car",
                         "the car is withdrawn; everyone behind moves up one place", car, as_of, drivers_meta))
    out.append(_scenario(world, race, base, positions_without(positions, car), "disqualified", "Disqualified after the race",
                         "a stewards' decision after the race: the same money as retiring, decided later", car, as_of, drivers_meta))
    d = state.drivers.get(car)
    return gate(out, d.status if d else "unknown", state.flag_status)


def plan_for(world: World, race: Race, state: RaceState, sig: IncidentSignal, team_cars: list[int], *, version: int, observed_at: str, drivers_meta,
             advisor: AdvisorNote | None = None) -> IncidentPlan | None:
    car = sig.driver_number
    if car is None:
        return None
    as_of = state.now_utc
    positions = state.positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    car_map = world.car_map(race.season)
    driver_id = car_map.get(car, {}).get("driver_id", f"car{car}")
    team_car = car in team_cars
    d = state.drivers.get(car)
    car_status = d.status if d else "unknown"
    scen = scenarios_for(world, race, state, car, as_of, drivers_meta)
    feasible = [s for s in scen if s.feasible]
    worst = min(scen, key=lambda s: s.delta_cents)
    basis = (f"car {car} ({driver_id}) at P{positions.get(car)} on lap {state.lap} under {state.flag_status}; provisional sponsor payout {usd(base.amount_cents)}; "
             + (f"largest change {worst.label.lower()}: {usd(worst.delta_cents)}" if worst.delta_cents else "no outcome changes the team's provisional payout")
             + ("" if team_car else f"; car {car} is a competitor's, so only the running order behind it moves our money; their garage and books are not ours to see"))
    note = (f"{len(feasible)} of {len(scen)} outcomes feasible for a car that is {car_status.replace('_', ' ')}"
            + ("; repair needs engineering clearance" if any(s.key == "repair_and_rejoin" and "engineering_clearance" in s.requires for s in scen) else ""))
    return IncidentPlan(incident_id=sig.incident_id, version=version, race_id=race.race_id, car=car, driver_id=driver_id, team_car=team_car,
                        scope="own_team" if team_car else "competitor", car_status=car_status, feasibility_note=note, as_of_utc=as_of or "",
                        observed_at_utc=observed_at, lap=state.lap, flag_status=state.flag_status, position_now=positions.get(car), exposure_now_cents=base.amount_cents or 0,
                        scenarios=scen, damage_estimate_cents=None, cost_cap_note=COST_CAP_NOTE if team_car else "Competitor car: no cost-cap question for us.",
                        advisor=advisor or AdvisorNote(), basis=basis,
                        timestamps=Timestamps(source_event=sig.event_time_utc, adapter_received=observed_at, finance_recomputed=observed_at))
