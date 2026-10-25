"""The decision cockpit's backend: who is actually racing, what each decision is worth, the race-long
timeline and the agents' per-event workflow. Every assertion is against the cached 2024 São Paulo slice."""

from live_racing.config import Config
from live_racing.finance_projections import if_finished_now
from live_racing.jev_router import JevRouter
from live_racing.publisher import MemorySink, Publisher
from live_racing.race_state import RaceState
from live_racing.replay import Replay, ReplayOptions
from live_racing.strategy import compare, positions_after_losing
from live_racing.team import LiveWorld, team_cars


def build(meta, events, t, team=(63, 44), withdrawals=()):
    st = RaceState("2024_sao_paulo_gp", meta["session"]["session_key"], meta["drivers"], list(team), withdrawals=withdrawals)
    for ev in events:
        if ev.event_time_utc > t:
            break
        st.apply(ev)
    return st


# ---------------------------------------------------------------- who is racing


def test_albon_is_dns_from_the_first_record_and_never_running(brazil, slice_meta, slice_events):
    early = build(slice_meta, slice_events, "2024-11-03T14:40:00.000Z", withdrawals=brazil.pre_race_withdrawals)
    assert early.drivers[23].status == "dns" and "withdrew" in early.drivers[23].out_reason
    lap31 = build(slice_meta, slice_events, "2024-11-03T16:35:00.000Z", withdrawals=brazil.pre_race_withdrawals)
    assert lap31.drivers[23].status == "dns" and lap31.drivers[23].to_state().position is None
    assert lap31.drivers[23].position is not None  # the feed still carries a position record for him; it proves nothing
    assert lap31.classified_positions()[23] is None


def test_dns_is_inferred_from_timing_without_mistaking_a_pit_lane_starter(slice_meta, slice_events):
    st = build(slice_meta, slice_events, "2024-11-03T15:56:00.000Z")  # leader on lap 5
    assert st.drivers[18].status == "dns"  # Stroll went off on the formation lap: no lap started
    assert st.drivers[55].status != "dns"  # Sainz started from the pit lane: no lap-1 record, lap 2 after the leader's
    later = build(slice_meta, slice_events, "2024-11-03T17:10:00.000Z")
    assert later.drivers[18].status == "dns"  # a lone lap-1 record during the red flag is a feed artefact, not a start


def test_out_cars_leave_the_classified_order_and_the_flag_matches_the_real_result(slice_meta, slice_events):
    st = build(slice_meta, slice_events, "2024-11-03T18:30:00.000Z")
    assert {n for n, d in st.drivers.items() if d.status == "retired"} == {27, 43, 55}  # Hülkenberg (black flag), Colapinto, Sainz
    order = [n for n, _ in sorted(((n, p) for n, p in st.classified_positions().items() if p), key=lambda x: x[1])]
    assert order[:15] == [1, 31, 10, 63, 16, 4, 22, 81, 30, 44, 11, 50, 77, 14, 24]  # the 2024 classification, P1-P15


def test_team_cars_are_this_sessions_entries(slice_meta):
    assert team_cars(LiveWorld("williams"), 2024, slice_meta["drivers"]) == [23, 43]  # not car 2: Sargeant raced for Williams earlier in 2024
    assert team_cars(LiveWorld("alpine"), 2024, slice_meta["drivers"]) == [10, 31]


# ---------------------------------------------------------------- the comparator


def test_comparator_prices_green_against_the_neutralisation(brazil, slice_meta, slice_events):
    world = LiveWorld("alpine")
    st = build(slice_meta, slice_events, "2024-11-03T16:36:00.000Z", team=(31, 10))  # Safety Car, Ocon leads, Gasly P3
    by = {c.car: c for c in compare(world, brazil, st, [31, 10], st.now_utc, slice_meta["drivers"])}
    ocon = {o.key: o for o in by[31].options}
    assert set(ocon) == {"stay_out", "pit_now", "pit_alt_compound", "pit_if_green"}
    assert ocon["stay_out"].delta_cents == 0 and by[31].lowest_risk == "stay_out"
    assert ocon["pit_now"].pit_loss.condition == "safety_car" and ocon["pit_if_green"].pit_loss.condition == "green"
    assert ocon["pit_now"].pit_loss.method in ("measured", "derived", "unmeasured")  # never a fixed factor
    assert ocon["pit_now"].delta_cents < 0 and any("win" in line for line in ocon["pit_now"].lines_lost)  # the stop gives up the leader's clauses
    assert ocon["pit_now"].position_best <= ocon["pit_now"].position_after <= ocon["pit_now"].position_worst
    assert ocon["pit_now"].expected_final_cents is None and "unavailable" in ocon["pit_now"].expected_final_status
    assert ocon["pit_now"].cost_cap_cents is None


def test_option_payout_is_the_contract_arithmetic_on_the_new_order(brazil, slice_meta, slice_events):
    world = LiveWorld("alpine")
    st = build(slice_meta, slice_events, "2024-11-03T16:36:00.000Z", team=(31, 10))
    gasly = next(c for c in compare(world, brazil, st, [31, 10], st.now_utc, slice_meta["drivers"]) if c.car == 10)
    stop = next(o for o in gasly.options if o.key == "pit_now")
    cp = st.classified_positions()
    expect = if_finished_now(world, brazil, positions_after_losing(cp, 10, len(stop.cars_passed)), as_of_utc=st.now_utc, drivers_meta=slice_meta["drivers"])
    assert stop.payout_after_cents == expect.amount_cents
    assert stop.payout_now_cents == if_finished_now(world, brazil, cp, as_of_utc=st.now_utc, drivers_meta=slice_meta["drivers"]).amount_cents


def test_red_flag_offers_a_tyre_change_not_a_free_repair_and_slicks_are_out_in_the_rain(brazil, slice_meta, slice_events):
    world = LiveWorld("alpine")
    red = build(slice_meta, slice_events, "2024-11-03T16:40:00.000Z", team=(31, 10))
    ocon = next(c for c in compare(world, brazil, red, [31, 10], red.now_utc, slice_meta["drivers"]) if c.car == 31)
    keys = [o.key for o in ocon.options]
    assert keys == ["stay_out", "tyres_in_suspension"]
    suspension = ocon.options[1]
    assert suspension.delta_cents == 0 and "restricted" in suspension.pit_loss.basis and any("repairs" in u for u in suspension.unknowns)


def test_dns_and_stopped_cars_get_no_options(brazil, slice_meta, slice_events):
    world = LiveWorld("williams")
    st = build(slice_meta, slice_events, "2024-11-03T16:37:15.000Z", team=(43, 23), withdrawals=brazil.pre_race_withdrawals)
    by = {c.car: c for c in compare(world, brazil, st, [43, 23], st.now_utc, slice_meta["drivers"])}
    assert by[23].options == [] and "did not start" in by[23].summary
    assert by[43].status == "stopped_candidate" and by[43].options == [] and "incident case" in by[43].summary


# ---------------------------------------------------------------- timeline and workflows


def _run(brazil, slice_meta, slice_events, team, from_lap=30, to_lap=34):
    mem = MemorySink()
    rp = Replay(brazil, slice_meta, slice_events, LiveWorld(team), Publisher([mem]), JevRouter(Config.from_env(), api_key=None, mode="api"),
                ReplayOptions(speed=float("inf"), from_lap=from_lap, to_lap=to_lap, demo=False), log=lambda s: None, replay_id=f"cockpit-{team}")
    rp.cases.headroom_fn = lambda: (None, "not asked in tests")
    rp.run()
    return rp, mem


def test_timeline_covers_the_race_from_lap_one_and_never_runs_ahead_of_the_clock(brazil, slice_meta, slice_events):
    rp, mem = _run(brazil, slice_meta, slice_events, "alpine")
    tl = mem.latest[("race_timeline", brazil.race_id)]["payload"]
    assert tl["laps"][0]["lap"] == 1 and tl["joined_lap"] == 30 and tl["start_utc"] == tl["laps"][0]["t"]
    assert all(p["t"] <= tl["now_utc"] for p in tl["points"]) and all(m["t"] <= tl["now_utc"] for m in tl["markers"])
    kinds = {m["kind"] for m in tl["markers"]}
    assert {"flag", "money", "out", "incident", "jev"} <= kinds
    # every lap completed in the state was finished by the replay clock: no lap time from the future
    assert all(x.completed_at <= rp.state.now_utc for x in rp.state.completed_laps.values())


def test_workflows_say_what_happened_and_competitors_never_reach_the_cost_cap(brazil, slice_meta, slice_events):
    rp, mem = _run(brazil, slice_meta, slice_events, "alpine")
    wfs = [r["payload"] for r in mem.of_kind("agent_workflow")]
    assert wfs and all([s["key"] for s in w["steps"]] == ["detected", "jev", "analyst", "cost_cap", "action", "outcome"] for w in wfs)
    crash = [w for w in wfs if w["case_id"] and w["car"] == 43]
    assert crash and all(w["scope"] == "competitor" for w in crash)
    assert all(next(s for s in w["steps"] if s["key"] == "cost_cap")["status"] == "not_required" for w in crash)
    # Jev had no key in this test: its step is never drawn as done
    assert all(next(s for s in w["steps"] if s["key"] == "jev")["status"] == "skipped" for w in wfs)


def test_own_car_workflow_waits_for_evidence_and_a_person(brazil, slice_meta, slice_events):
    rp, mem = _run(brazil, slice_meta, slice_events, "williams")
    crash = [r["payload"] for r in mem.of_kind("agent_workflow") if r["payload"]["car"] == 43 and r["payload"]["case_id"]]
    assert crash and all(w["scope"] == "own_team" for w in crash)
    last = crash[-1]
    steps = {s["key"]: s for s in last["steps"]}
    assert steps["cost_cap"]["status"] == "waiting" and "garage report" in steps["cost_cap"]["detail"]
    assert steps["outcome"]["status"] == "waiting" and not last["needs_person"]
    case = rp.cases._for("2024_sao_paulo_gp:race:lap32:car43:crash_candidate")
    rp.cases.demo_garage_report(case.case_id, rp.state.now_utc)
    after = mem.latest[("agent_workflow", last["workflow_id"])]["payload"]
    assert after["needs_person"] and {s["key"]: s for s in after["steps"]}["action"]["status"] == "escalated"
    assert {s["key"]: s for s in after["steps"]}["cost_cap"]["status"] in ("done", "escalated")
