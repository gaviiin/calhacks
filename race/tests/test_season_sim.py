import json
import time
from types import SimpleNamespace

from race import season_sim
from race.events import Incident
from race.openf1 import load_fixture
from race.tests.conftest import FIXTURES
from race.weekend import WeekendState, weekend_info

RACE = 9636


def _drivers():
    return {int(d["driver_number"]): d["team_name"] for d in load_fixture(RACE, FIXTURES)["drivers"]}


def _replay(positions=None, lap_at=None):
    rows = load_fixture(RACE, FIXTURES)
    return SimpleNamespace(team_of=_drivers(), ctx=SimpleNamespace(positions=dict(positions or {})),
                           session={"session_key": RACE, "date_start": "2024-11-03T15:30:00+00:00"}, rows={"laps": rows["laps"]})


def state(**kw) -> WeekendState:
    st = WeekendState(meeting_key=1249, info=weekend_info(1249), team="Williams")
    st.session = {"session_key": 9627, "date_start": "2024-11-03T10:30:00+00:00"}
    st.replay = _replay()
    st.replay.session = {"session_key": 9627}
    for k, v in kw.items():
        setattr(st, k, v)
    return st


def baseline_and_final():
    st = state()
    base = season_sim.run(st, "baseline")
    st.sims.append(base)
    st.replay = _replay()
    st.results[RACE] = load_fixture(RACE, FIXTURES)["session_result"]
    st.now = "2024-11-03T17:58:52.000Z"
    return st, base, season_sim.run(st, f"result:{RACE}")


def test_standings_at_the_weekend_start_include_the_sprint():
    start = season_sim.standings_at_start(season_sim._season(2024), 21)
    assert start["Williams"] == 17 and start["Alpine"] == 16 and start["Haas F1 Team"] == 46 and start["RB"] == 36


def test_deterministic_and_common_draws_across_triggers():
    a = season_sim.run(state(), "baseline").payload
    b = season_sim.run(state(), "baseline").payload
    assert a == b
    st = state()
    st.sims.append(season_sim.run(st, "baseline"))
    c = season_sim.run(st, "incident:x@v1").payload  # nothing changed: the same draws give the same answer
    assert c["seed"] == a["seed"] and c["p_target"] == a["p_target"] and c["prize"]["delta_cents"] == 0
    assert c["headline"].startswith("unchanged")


def test_baseline_p8_well_above_post_race_and_post_race_under_ten_percent():
    _, base, final = baseline_and_final()
    pb, pf = base.payload["p_target"], final.payload["p_target"]
    assert base.payload["target_position"] == 8 and base.payload["headline_value"].startswith("P(P8)")
    assert pb > 0.4 and pb - pf > 0.3
    assert pf < 0.10
    assert final.payload["phase"] == "result"
    assert final.payload["prize"]["delta_cents"] < 0 and final.payload["tone"] == "alert"
    assert final.payload["headline"].startswith("down from")


def test_attribution_splits_the_change():
    _, _, final = baseline_and_final()
    a, pr = final.payload["attribution"], final.payload["prize"]
    assert abs(a["ours_cents"] + a["rivals_cents"] - pr["delta_cents"]) <= 1
    # Alpine's double podium, not our crashes, decided P8: our 0 points vs our expected ~1 changes little
    assert a["rivals_cents"] < 0 and abs(a["ours_cents"]) < abs(a["rivals_cents"])


def test_runtime_and_payload_size():
    st = state()
    t0 = time.perf_counter()
    run = season_sim.run(st, "baseline")
    assert time.perf_counter() - t0 < 1.0
    raw = json.dumps(run.payload, separators=(",", ":"))
    assert len(raw) < 16_384 and json.loads(run.wire()["payload_json"]) == json.loads(raw)
    p = run.payload
    assert len(p["dist"]) == 10 and abs(sum(p["dist"]) - 1) < 1e-3
    assert {r["team"] for r in p["rivals"]} >= {"Alpine", "RB"}
    assert p["prize"]["p10_cents"] <= p["prize"]["p50_cents"] <= p["prize"]["p90_cents"] and p["prize"]["basis"]
    # the keys race/close.py reads
    assert p["p_p8"] == p["p_target"] and p["cap"]["deferral_cents"] == p["cap"]["defer_cents"] and p["cap"]["year_end_mid_cents"] > 0
    assert any(r["team"] == "Alpine" for r in p["rivals"]) and "ours_cents" in p["attribution"] and "expected_cents" in p["sponsor"]
    assert 70 <= p["atr"]["expected_pct"] <= 115 and p["sponsor"]["assumption"] is True and "cap" in p


def test_atr_scale():
    assert [season_sim.atr_pct(p) for p in (1, 7, 10)] == [70, 100, 115]


def test_a_confirmed_dns_scores_nothing():
    st = state()
    free = season_sim.run(st, "baseline").payload
    st.incidents["k"] = Incident(incident_key="k", meeting_key=1249, session_key=9627, driver_number=23, team_name="Williams",
                                 first_seen_at="2024-11-03T11:57:19Z", status="assessed", belief={"dns": True})
    out = season_sim.run(st, "baseline").payload
    assert out["out_cars"] == [23]
    assert out["weekend_expected_points"] < free["weekend_expected_points"]


def test_live_running_order_moves_the_odds():
    def at(pos):
        st = state()
        st.replay = _replay(pos)
        st.now = "2024-11-03T17:55:00Z"  # lap 68 of 69
        return season_sim.run(st, "incident:live@v1").payload

    order = list(_drivers())
    ours_front = {c: i + 1 for i, c in enumerate([23, 43] + [c for c in order if c not in (23, 43)])}
    ours_out = {**{c: i + 1 for i, c in enumerate([c for c in order if c not in (23, 43)])}, 23: None, 43: None}
    front, out = at(ours_front), at(ours_out)
    assert front["phase"].startswith("live lap") and front["weekend_expected_points"] > 35
    assert out["weekend_expected_points"] == 0
    assert front["p_target"] > out["p_target"]
