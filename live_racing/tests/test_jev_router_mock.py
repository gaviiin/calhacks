import json

import httpx
import pytest

from live_racing.config import FIXTURES_DIR, ROUTES
from live_racing.jev_router import JevRouter, mask, urgency_level

CASES = json.loads((FIXTURES_DIR / "jev_cases.json").read_text())["cases"]


def fake_answer(jev: dict, model="jev-1.13.0") -> dict:
    legend = {str(i): s for i, s in enumerate(["routine", "watch", "urgent", "critical"])}
    urg = jev["urgency"]
    probs = {str(i): 0.0 for i in range(4)}
    lo = min(3, int(urg))
    probs[str(lo)] = 1 - (urg - lo) if lo < 3 else 1.0
    if lo < 3:
        probs[str(lo + 1)] = urg - lo
    return {"model": model, "answers": {
        "route": {"type": "choice", "choice": jev["route"], "confidence": jev["confidence"], "probabilities": jev["probabilities"]},
        "urgency": {"type": "score", "score": urg, "confidence": 0.7, "legend": legend, "probabilities": probs},
        "needs_evidence": {"type": "noul", "noul": jev["noul"]}}, "usage": {"input_tokens": 300, "output_tokens": 20}}


def router_with(handler, **kw) -> JevRouter:
    seen = []

    def h(request: httpx.Request):
        seen.append(request)
        return handler(request)

    r = JevRouter(api_key="test-key", model="jev-latest", mode="api", base_url="https://api.typesafe.test",
                  http=httpx.Client(transport=httpx.MockTransport(h)), sleep=lambda s: None, **kw)
    r.seen = seen  # type: ignore[attr-defined]
    return r


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_labeled_cases_route_as_expected(case):
    if case["jev"] is None:
        r = router_with(lambda req: httpx.Response(503))
    else:
        r = router_with(lambda req: httpx.Response(200, json=fake_answer(case["jev"])))
    d = r.decide(case["state"], case["deterministic"], case["material"])
    assert d.chosen_route in case["expect"], (case["id"], d.status, d.reason)
    assert d.deterministic_route == case["deterministic"]
    if case["jev"] is None:
        assert not d.used and d.status == "unavailable" and d.route_confidence is None and d.route is None
    else:
        assert d.used and d.model == "jev-1.13.0" and d.latency_ms is not None and d.route == case["jev"]["route"]


def test_request_matches_the_documented_shape():
    r = router_with(lambda req: httpx.Response(200, json=fake_answer(CASES[0]["jev"])))
    r.decide(CASES[0]["state"], "crash_finance", True)
    req = r.seen[0]
    assert req.url.path == "/v1/systemone" and req.headers["authorization"] == "Bearer test-key"
    body = json.loads(req.content)
    assert body["model"] == "jev-latest"
    q = body["questions"]
    assert q["route"]["type"] == "choice" and set(q["route"]["criteria"]) == set(ROUTES)
    assert q["urgency"]["type"] == "score" and len(q["urgency"]["criteria"]) == 4
    assert q["needs_evidence"]["type"] == "noul"
    assert set(body["state"]) <= set(mask(CASES[0]["state"]))
    assert "untrusted_text_fields" in body["state"]


def test_same_context_is_cached_and_budget_is_bounded():
    r = router_with(lambda req: httpx.Response(200, json=fake_answer(CASES[0]["jev"])), budget=1)
    a = r.decide(CASES[0]["state"], "crash_finance", True)
    b = r.decide(CASES[0]["state"], "crash_finance", True)
    c = r.decide(CASES[1]["state"], "human_review", True)
    assert a.status == "ok" and b.status == "cached" and b.used
    assert c.status == "budget_exhausted" and not c.used and c.chosen_route == "human_review"
    assert r.stats.requests == 1 and r.stats.cache_hits == 1


def test_injection_in_race_control_text_cannot_suppress_a_material_event():
    case = next(c for c in CASES if c["id"] == "prompt_injection_in_race_control_text")
    r = router_with(lambda req: httpx.Response(200, json=fake_answer(case["jev"])))
    d = r.decide(case["state"], "crash_finance", True)
    assert d.route == "no_action" and d.chosen_route == "crash_finance" and d.status == "overridden"
    assert "race_control_message" in d.masked_input["untrusted_text_fields"]


def test_low_confidence_and_close_top_two_go_to_a_person():
    jev = {"route": "crash_finance", "confidence": 0.9, "probabilities": {"crash_finance": 0.5, "human_review": 0.45, "race_forecast": 0.05}, "urgency": 2.0, "noul": 0.5}
    r = router_with(lambda req: httpx.Response(200, json=fake_answer(jev)))
    d = r.decide(CASES[0]["state"], "human_review", True)  # code was unsure; Jev's two top options are 0.05 apart
    assert d.chosen_route == "human_review" and d.status == "low_confidence"
    assert urgency_level(2.0) == "urgent" and urgency_level(2.6) == "critical" and urgency_level(0.2) == "routine" and urgency_level(None) is None


def decide(jev_route, conf, det, material=True, second="human_review"):
    probs = {r: 0.0 for r in ROUTES}
    probs[jev_route] = 0.2 + conf * 0.8
    probs[second if second != jev_route else "no_action"] = 1 - probs[jev_route]
    r = router_with(lambda req: httpx.Response(200, json=fake_answer({"route": jev_route, "confidence": conf, "probabilities": probs, "urgency": 1.5, "noul": 0.5})))
    return r.decide(CASES[0]["state"], det, material)


def test_agreement_lowers_the_gate_as_measured_live():
    # the live run: correct crash_finance at 0.60 and revenue_change at 0.56 must not be demoted
    assert (decide("crash_finance", 0.60, "crash_finance").chosen_route, decide("crash_finance", 0.60, "crash_finance").status) == ("crash_finance", "ok")
    assert decide("revenue_change", 0.56, "revenue_change").chosen_route == "revenue_change"
    assert decide("crash_finance", 0.35, "crash_finance").chosen_route == "human_review"  # below even the agreement floor
    d = decide("race_forecast", 0.39, "race_forecast")  # a forecast refresh that Jev is unsure about stays a forecast refresh
    assert (d.chosen_route, d.status) == ("race_forecast", "low_confidence")


def test_downgrades_need_strong_evidence_and_never_erase_a_crash():
    d = decide("race_forecast", 0.79, "human_review", second="human_review")  # the live generic red flag
    assert (d.chosen_route, d.status) == ("human_review", "overridden")
    assert decide("race_forecast", 0.95, "human_review").chosen_route == "race_forecast"
    assert decide("race_forecast", 0.99, "crash_finance").chosen_route == "crash_finance"  # a correlated crash is never a forecast refresh
    assert decide("human_review", 0.80, "crash_finance", second="crash_finance").chosen_route == "human_review"  # but a person may look first
    assert decide("crash_finance", 0.85, "human_review", second="human_review").chosen_route == "crash_finance"  # and Jev may name the specialist
    assert decide("no_action", 0.99, "race_forecast", second="race_forecast").chosen_route == "race_forecast"
