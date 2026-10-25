import json

from live_racing.config import Config
from live_racing.jev_router import JevRouter
from live_racing.publisher import JsonlSink, MemorySink, Publisher
from live_racing.replay import Replay, ReplayOptions


def run_once(world, brazil, slice_meta, slice_events, tmp_path, name):
    mem = MemorySink()
    pub = Publisher([mem, JsonlSink(tmp_path / f"{name}.jsonl")])
    jev = JevRouter(Config.from_env(), api_key=None, mode="api")
    rp = Replay(brazil, slice_meta, slice_events, world, pub, jev, ReplayOptions(speed=float("inf"), from_lap=28, to_lap=34, corroborate_after_s=60),
                log=lambda s: None, replay_id="fixed")
    rp.run()
    return rp, mem


def test_same_slice_twice_gives_the_same_incidents_and_decisions(world, brazil, slice_meta, slice_events, tmp_path, quiet):
    a, ma = run_once(world, brazil, slice_meta, slice_events, tmp_path, "a")
    b, mb = run_once(world, brazil, slice_meta, slice_events, tmp_path, "b")
    assert a.status.state == "finished" and b.status.state == "finished"
    assert {k: v.version for k, v in a.incidents.items()} == {k: v.version for k, v in b.incidents.items()}
    assert "2024_sao_paulo_gp:race:lap32:car43:crash_candidate" in a.incidents
    assert [(d["kind"], d["at"], d["decision"]["chosen_route"]) for d in a.decisions] == [(d["kind"], d["at"], d["decision"]["chosen_route"]) for d in b.decisions]
    ids_a = [(r["kind"], r["id"], r["version"]) for r in ma.records if r["kind"] != "feed_health"]  # health is wall-clock paced
    ids_b = [(r["kind"], r["id"], r["version"]) for r in mb.records if r["kind"] != "feed_health"]
    assert ids_a == ids_b
    assert ma.of_kind("strategy_advice") and ma.of_kind("incident_plan") and ma.of_kind("feed_health")
    plan = [r["payload"] for r in ma.records if r["kind"] == "incident_plan" and r["id"].endswith("car43:crash_candidate")]
    assert plan and plan[0]["advisor"]["status"] == "disabled" and plan[0]["damage_estimate_cents"] is None
    health = ma.of_kind("feed_health")[0]["payload"]
    assert {s["name"] for s in health["sinks"]} == {"memory", "jsonl"} and health["publishes_total"] > 0 and health["exposure_peak_cents"] is not None
    # the memory sink keeps one row per (kind, id): two incidents, one race state, one status
    assert len(ma.of_kind("incident_signal")) == 2 and len(ma.of_kind("race_state")) == 1
    lines = [json.loads(l) for l in (tmp_path / "a.jsonl").read_text().splitlines()]
    assert len({(l["kind"], l["id"], l["version"]) for l in lines}) == len(lines)


def test_the_incident_is_attributed_corroborated_and_handed_off_in_order(world, brazil, slice_meta, slice_events, tmp_path, quiet):
    rp, mem = run_once(world, brazil, slice_meta, slice_events, tmp_path, "c")
    versions = [r["payload"] for r in mem.records if r["kind"] == "incident_signal" and r["id"].endswith("car43:crash_candidate")]
    assert [v["version"] for v in versions] == [1, 2, 3]
    assert versions[0]["sporting_confirmation"] == "incident_candidate" and versions[0]["driver_attribution"] == "provisionally_correlated"
    assert versions[1]["jev"]["chosen_route"] == "crash_finance" and versions[1]["jev"]["used"] is False and versions[1]["jev"]["status"] == "unavailable"
    assert versions[2]["sporting_confirmation"] == "verified_historical_incident" and versions[2]["handoff"] == {
        "target": "cost_cap_agent", "status": "requested", "requested_at_utc": versions[2]["handoff"]["requested_at_utc"], "acknowledged_at_utc": None, "finance_impact_ref": None}
    assert versions[2]["corroborating_source_url"].startswith("https://www.formula1.com/")
    assert all(v["financial_impact"]["status"] == "unknown" and v["financial_impact"]["amount_cents"] is None for v in versions)
    m = rp.metrics()
    assert m["jev"]["calls_on_telemetry_ticks"] == 0 and m["jev"]["requests"] == 0 and m["state_updates"] > 50
    states = [r["payload"] for r in mem.records if r["kind"] == "race_state"]
    assert all(s["forecast"]["status"] == "indicative" for s in states)
    assert any(s["forecast_change"] and s["forecast_change"]["lost"] for s in states)
    assert all(s["timestamps"]["state_published"] and s["timestamps"]["adapter_received"] for s in states)
