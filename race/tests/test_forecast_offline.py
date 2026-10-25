import json

from race.effects import EffectsContext, effects_for
from race.events import CarState, RaceEvent
from race.forecast_agent import ForecastAgent
from race.jev import offline_decide

TEAM_OF = {23: "Williams", 55: "Williams", 81: "McLaren", 4: "McLaren", 1: "Red Bull Racing"}


class _Sink:
    def __init__(self):
        self.rows = []

    def forecast(self, row):
        self.rows.append(dict(row))
        return True


def test_offline_forecast_has_a_timeline_and_ordered_bands():
    ctx = EffectsContext(team="Williams", team_of=TEAM_OF, standings_start={"McLaren": 300.0, "Red Bull Racing": 65.0, "Williams": 60.0, "Haas F1 Team": 62.0},
                         positions={23: 8, 55: 12, 81: 1, 4: 2, 1: 3}, next_race_days=6, next_race_flyaway=True)
    ev = RaceEvent(kind="retirement_suspected", at="2026-05-24T16:25:37Z", session_key=11291, meeting_key=1285, lap=12, driver_number=23,
                   team_name="Williams", payload={"last_lap": 12, "summary": "no lap since L12"},
                   state=CarState(23, "Williams", position=8, lap=12, compound="MEDIUM", tyre_age=11, updated_at="2026-05-24T16:25:37Z"))
    jev = offline_decide(ev, {"team_cars": [23, 55], "retired_within_laps": 0})
    effects = effects_for(ev, jev, None, ctx)
    sink = _Sink()
    row = ForecastAgent(ctx, sink, offline=True).run(ev, jev, effects)
    assert [r["status"] for r in sink.rows] == ["running", "offline"]
    assert row["status"] == "offline" and row["event_key"] == ev.key and row["summary"]
    plan = json.loads(row["payload_json"])
    assert 6 <= len(plan["steps"]) <= 8
    assert [s["t"] for s in plan["steps"]] == sorted(s["t"] for s in plan["steps"])
    for s in plan["steps"]:
        assert s["cents_low"] <= s["cents_mid"] <= s["cents_high"], s["label"]
    t = plan["totals"]
    assert t["low"] <= t["mid"] <= t["high"] and t["mid"] > 0
    assert plan["parts"] and all({"part", "p", "low", "mid", "high", "basis", "in_spares", "lead_days"} <= set(p) for p in plan["parts"])
    assert plan["cap"]["headroom_after"] < plan["cap"]["headroom_before"]
    assert plan["prize"]["position_after"] == 4  # retired from P8: Williams drops behind Haas
    labels = " ".join(s["label"] for s in plan["steps"])
    assert "Fit before next race" in labels and "Month-end cap position" in labels and "Season-end prize money" in labels
    assert "$" in row["summary"] and "m mid" in row["summary"]
