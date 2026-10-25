import httpx

from live_racing.advisor import Advisor, AdvisorOut
from live_racing.finance_projections import if_finished_now
from live_racing.incident_planner import plan_for, scenarios_for
from live_racing.race_state import RaceState
from live_racing.schemas import IncidentSignal, JevDecision
from live_racing.strategy import (cars_behind_within, effective_pit_loss, pit_loss, place_values, pit_scenarios, positions_after_losing, positions_without,
                                  strategy_advice)
from live_racing.tests.test_race_state_no_lookahead import build_to


def test_place_values_price_one_place_each_way(world, brazil, slice_meta, slice_events):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:29:00.000Z")
    pv = {p.car: p for p in place_values(world, brazil, st, [63, 44], st.now_utc, slice_meta["drivers"])}
    assert pv[63].position == 1 and pv[63].up_one_cents == 0 and pv[63].up_one_text == "already leading"
    assert pv[63].down_one_cents == -100_000_000  # P1 -> P2: the $2M win becomes the $1M podium (Arcadia's podium clause keeps paying)
    assert pv[44].position == 12 and pv[44].up_one_cents == 0 and pv[44].down_one_cents == 0  # P11/P13 pay nothing either way
    later = build_to(slice_meta, slice_events, "2024-11-03T16:33:00.000Z")
    pv2 = {p.car: p for p in place_values(world, brazil, later, [63, 44], later.now_utc, slice_meta["drivers"])}
    assert pv2[44].position == 10 and pv2[44].down_one_cents < 0 and "P10 -> P11" in pv2[44].down_one_text  # the last point is worth Volta's clause


def test_pit_loss_uses_this_race_and_the_flag(slice_meta, slice_events):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:29:00.000Z")  # the Virtual Safety Car is out (16:28:21)
    base, basis = pit_loss(st)
    loss, ebasis, under = effective_pit_loss(st)
    assert 20 < base < 30 and "median pit-lane time" in basis
    assert under == "VSC" and loss == base * 0.6 and "Virtual Safety Car" in ebasis
    red = build_to(slice_meta, slice_events, "2024-11-03T16:37:30.000Z")
    assert effective_pit_loss(red)[0] == 0.0 and effective_pit_loss(red)[2] == "RED_FLAG"
    fresh = RaceState("r", 1, [{"driver_number": 1}], [1])
    assert effective_pit_loss(fresh) == (23.0, "default (no normal stop seen yet in this race)", None)


def test_pit_scenario_counts_the_cars_that_would_get_past(world, brazil, slice_meta, slice_events):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:29:00.000Z")
    passed, maybe = cars_behind_within(st, 63, 60.0)
    assert passed and all(st.drivers[n].position > 1 for n in passed)
    assert cars_behind_within(st, 63, 0.01) == ([], []) or cars_behind_within(st, 63, 0.01)[0] == []
    sc = pit_scenarios(world, brazil, st, [63, 44], st.now_utc, slice_meta["drivers"])
    s63 = next(s for s in sc if s.car == 63)
    assert s63.positions_lost == len(s63.cars_passed) and s63.rejoin_position == 1 + s63.positions_lost
    assert s63.delta_cents <= 0 and "Pit now from P1" in s63.text
    red = build_to(slice_meta, slice_events, "2024-11-03T16:37:30.000Z")
    s_red = next(s for s in pit_scenarios(world, brazil, red, [63, 44], red.now_utc, slice_meta["drivers"]) if s.car == 63)
    assert s_red.pit_loss_s == 0 and s_red.positions_lost == 0 and s_red.delta_cents == 0


def test_order_arithmetic():
    pos = {1: 1, 2: 2, 3: 3, 4: 4}
    assert positions_after_losing(pos, 1, 2) == {1: 3, 2: 1, 3: 2, 4: 4}
    assert positions_without(pos, 2) == {1: 1, 3: 2, 4: 3}
    assert positions_after_losing(pos, 9, 2) == pos


def test_strategy_advice_carries_the_tally(world, brazil, slice_meta, slice_events):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:33:00.000Z")
    adv = strategy_advice(world, brazil, st, [63, 44], version=3, observed_at="2026-01-01T00:00:00.000Z", drivers_meta=slice_meta["drivers"],
                          exposure_at_join=274_000_000, exposure_peak=285_000_000)
    assert adv.exposure_now_cents == 36_908_000 and adv.lost_from_peak_cents == 285_000_000 - 36_908_000
    assert {p.car for p in adv.places} == {63, 44} and len(adv.pit) == 2 and len(adv.tyres) == 2 and adv.status == "indicative"
    assert "measurement, not a forecast" in adv.weather_note
    sc = next(x for x in adv.pit if x.car == 63)  # under the Safety Car at 16:33: the green counterfactual is the dearer one
    assert sc.under == "SAFETY_CAR" and sc.green_pit_loss_s > sc.pit_loss_s and (sc.green_delta_cents or 0) <= sc.delta_cents
    assert any(line.startswith("Under the Safety Car a stop costs Russell") for line in adv.levers)
    assert any("Rain is falling" in line for line in adv.levers)


def _signal(car, lap=32):
    return IncidentSignal(incident_id=f"2024_sao_paulo_gp:race:lap{lap}:car{car}:crash_candidate", sporting_source_date="2024-11-03", race_id="2024_sao_paulo_gp", lap=lap,
                          driver_number=car, jev=JevDecision(deterministic_route="crash_finance", chosen_route="crash_finance"),
                          event_time_utc="2024-11-03T16:37:22.000Z", observed_at_utc="2026-01-01T00:00:00.000Z")


def test_incident_scenarios_for_the_leader_and_for_the_other_teams_car(world, brazil, slice_meta, slice_events):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:29:00.000Z")  # Russell leads: every clause is on car 63
    scen = {s.key: s for s in scenarios_for(world, brazil, st, 63, st.now_utc, slice_meta["drivers"])}
    base = if_finished_now(world, brazil, st.positions(), as_of_utc=st.now_utc, drivers_meta=slice_meta["drivers"]).amount_cents
    assert scen["continue"].delta_cents == 0
    assert scen["retire"].delta_cents == -base and scen["retire"].exposure_after_cents == 0  # every clause was on car 63
    assert scen["disqualified"].exposure_after_cents == scen["retire"].exposure_after_cents
    assert scen["penalty_5s"].delta_cents >= scen["drive_through"].delta_cents >= scen["retire"].delta_cents
    assert scen["repair_and_rejoin"].position_after is not None and "assumption" in scen["repair_and_rejoin"].assumption
    red = build_to(slice_meta, slice_events, "2024-11-03T16:37:30.000Z")
    plan = plan_for(world, brazil, red, _signal(43), [63, 44], version=1, observed_at="2026-01-01T00:00:00.000Z", drivers_meta=slice_meta["drivers"])
    assert plan is not None and plan.team_car is False and plan.scope == "competitor" and plan.damage_estimate_cents is None
    assert plan.cost_cap_note.startswith("Competitor car")
    keys = [s.key for s in plan.scenarios]
    assert keys == ["continue", "pit_now", "repair_and_rejoin", "penalty_5s", "penalty_10s", "drive_through", "retire", "disqualified"]
    assert all(s.delta_cents == 0 for s in plan.scenarios)  # car 43 at P16 moves none of Meridian's money
    assert "competitor's" in plan.basis and plan.advisor.status == "disabled"
    # the feasibility gate: car 43 is stationary, so continuing, pitting and penalties are out, and a repair needs engineering
    by = {s.key: s for s in plan.scenarios}
    assert plan.car_status == "stopped_candidate"
    assert all(not by[k].feasible for k in ("continue", "pit_now", "penalty_5s", "penalty_10s", "drive_through"))
    assert not by["repair_and_rejoin"].feasible and by["repair_and_rejoin"].requires == ["engineering_clearance"]
    assert by["retire"].feasible and by["disqualified"].requires == ["stewards_decision"]
    assert "frees track position, not the parts cost" in by["repair_and_rejoin"].why
    # the same incident with the car as our own (Williams-mirror)
    from live_racing.team import LiveWorld
    own = plan_for(LiveWorld("williams"), brazil, red, _signal(43), [43, 23, 2], version=1, observed_at="2026-01-01T00:00:00.000Z", drivers_meta=slice_meta["drivers"])
    assert own.scope == "own_team" and "garage report" in own.cost_cap_note and own.feasibility_note.startswith("2 of 8 outcomes feasible")


def test_advisor_is_honest_when_off_and_grounded_when_on(world, brazil, slice_meta, slice_events, monkeypatch):
    monkeypatch.setenv("LIVE_ADVISOR", "off")
    off = Advisor()
    assert not off.enabled and off.describe().startswith("off")
    st = build_to(slice_meta, slice_events, "2024-11-03T16:29:00.000Z")
    plan = plan_for(world, brazil, st, _signal(63, lap=28), [63, 44], version=1, observed_at="2026-01-01T00:00:00.000Z", drivers_meta=slice_meta["drivers"])
    assert off.advise(plan, {}).status == "disabled"

    class FakeMsg:
        stop_reason = "end_turn"
        model = "claude-opus-5-5"
        parsed_output = AdvisorOut(recommended_scenario="repair_and_rejoin", headline="Repair and rejoin; the win is already gone", rationale="x", what_we_need=["damage"],
                                   confidence="medium")

    class FakeParse:
        def __init__(self):
            self.calls = []

        def parse(self, **kw):
            self.calls.append(kw)
            return FakeMsg()

    class FakeClient:
        def __init__(self):
            self.beta = type("B", (), {})()
            self.beta.messages = FakeParse()

    fake = FakeClient()
    on = Advisor(enabled=True, model="claude-opus-5-5", client=fake)
    note = on.advise(plan, {"message": "RED FLAG"})
    assert note.used and note.status == "ok" and note.recommended_scenario == "repair_and_rejoin" and note.confidence == "medium" and note.latency_ms is not None
    kw = fake.beta.messages.calls[0]
    assert kw["model"] == "claude-opus-5-5" and kw["output_config"] == {"effort": "low"} and kw["fallbacks"] == "default" and "thinking" not in kw
    assert "scenarios" in kw["messages"][0]["content"] and "never invent a repair cost" in kw["system"]

    FakeMsg.parsed_output = AdvisorOut(recommended_scenario="sell_the_team", headline="h", rationale="r", confidence="high")
    bad = on.advise(plan, {})
    assert not bad.used and bad.status == "invalid" and "unknown scenario key" in bad.error

    class Boom:
        def parse(self, **kw):
            raise httpx.ConnectError("down")

    fake.beta.messages = Boom()
    err = on.advise(plan, {})
    assert not err.used and err.status == "error" and "ConnectError" in err.error
