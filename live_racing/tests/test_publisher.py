import json

import httpx

from live_racing.publisher import MemorySink, Publisher, SpacetimeSink, WebhookSink
from live_racing.schemas import RaceStateUpdate, Timestamps


def big_state(n=40):
    return RaceStateUpdate(event_id="e", source_url="u", event_time_utc="2024-11-03T16:37:22.000Z", observed_at_utc="2026-01-01T00:00:00.000Z", session_key=9636,
                           race_id="2024_sao_paulo_gp", team_cars=[63, 44],
                           driver_states=[{"driver_number": i, "team": "x" * 150, "status": "running"} for i in range(1, n)] + [{"driver_number": 63, "status": "running"}])


def test_spacetime_sink_calls_mirror_item_with_six_args_and_truncates():
    calls = []

    def h(req: httpx.Request):
        calls.append(json.loads(req.content))
        return httpx.Response(200)

    sink = SpacetimeSink("rid", "http://stdb.test", "pit-wall", "tok", http=httpx.Client(transport=httpx.MockTransport(h)))
    pub = Publisher([sink])
    pub.publish("race_state", big_state(), id="2024_sao_paulo_gp", version=3, status="RED_FLAG")
    [args] = calls
    assert len(args) == 6 and args[0] == "live:race_state:2024_sao_paulo_gp" and args[1] == "rid" and args[2] == "live_race_state" and args[3] == "RED_FLAG"
    payload = json.loads(args[4])["payload"]
    assert payload["truncated"] is True and [d["driver_number"] for d in payload["driver_states"]] == [63]
    assert len(args[4]) <= 8000 and sink.written == 1


def test_spacetime_sink_switches_itself_off_when_unreachable():
    def h(req):
        raise httpx.ConnectError("no", request=req)

    sink = SpacetimeSink("rid", "http://stdb.test", "pit-wall", "tok", http=httpx.Client(transport=httpx.MockTransport(h)))
    pub = Publisher([sink])
    pub.publish("race_state", big_state(3), id="x")
    pub.publish("race_state", big_state(3), id="x")
    assert sink.disabled and "unreachable" in sink.disabled_reason and pub.names() == [f"spacetimedb (off: {sink.disabled_reason})"]


def test_webhook_only_forwards_signals_and_memory_sink_upserts():
    posted = []
    hook = WebhookSink("http://agent.test/incidents", http=httpx.Client(transport=httpx.MockTransport(lambda r: (posted.append(json.loads(r.content)), httpx.Response(204))[1])))
    mem = MemorySink()
    pub = Publisher([mem, hook])
    pub.publish("race_state", {"timestamps": {}}, id="s", adapter_received_utc="2020-01-01T00:00:00.000Z")
    pub.publish("incident_signal", {"incident_id": "i"}, id="i", version=1)
    pub.publish("incident_signal", {"incident_id": "i", "v": 2}, id="i", version=2)
    assert [p["kind"] for p in posted] == ["incident_signal", "incident_signal"] and hook.sent == 2
    assert len(mem.of_kind("incident_signal")) == 1 and mem.of_kind("incident_signal")[0]["version"] == 2
    assert len(mem.since(0)) == 3 and len(mem.since(1, ["incident_signal"])) == 2
    assert mem.records[0]["payload"]["timestamps"]["state_published"] and pub.publish_latencies_ms[0] > 0
