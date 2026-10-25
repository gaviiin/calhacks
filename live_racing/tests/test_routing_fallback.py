import httpx
import pytest

from live_racing.jev_router import JevRouter
from live_racing.tests.test_jev_router_mock import CASES, fake_answer, router_with

STATE = CASES[0]["state"]


def test_without_a_key_nothing_is_claimed():
    r = JevRouter(api_key=None, mode="api", model="jev-latest", http=httpx.Client(transport=httpx.MockTransport(lambda q: httpx.Response(500))))
    d = r.decide(STATE, "crash_finance", True)
    assert not d.used and d.status == "unavailable" and d.chosen_route == "crash_finance" and d.model is None
    assert d.route_confidence is None and d.urgency is None and d.latency_ms is None
    assert r.stats.requests == 0 and "deterministic fallback" in r.describe()
    off = JevRouter(api_key="k", mode="deterministic_fallback", model="jev-latest")
    assert off.decide(STATE, "race_forecast", True).status == "disabled"


@pytest.mark.parametrize("status", [401, 422, 404])
def test_hard_http_errors_fall_back_without_retry(status):
    r = router_with(lambda req: httpx.Response(status, text="nope"))
    d = r.decide(STATE, "crash_finance", True)
    assert not d.used and d.status == "unavailable" and str(status) in d.error and d.chosen_route == "crash_finance"
    assert r.stats.requests == 1 and r.stats.errors == 1


def test_429_honours_retry_after_once():
    calls = []
    slept = []

    def h(req):
        calls.append(1)
        return httpx.Response(429, headers={"Retry-After": "2"}) if len(calls) == 1 else httpx.Response(200, json=fake_answer(CASES[0]["jev"]))

    r = router_with(h)
    r.sleep = slept.append
    d = r.decide(STATE, "crash_finance", True)
    assert d.used and d.status == "ok" and slept == [2.0] and r.stats.requests == 2


def test_server_errors_and_timeouts_fall_back():
    r = router_with(lambda req: httpx.Response(503))
    d = r.decide(STATE, "crash_finance", True)
    assert d.status == "unavailable" and d.error == "HTTP 503" and r.stats.requests == 2

    def boom(req):
        raise httpx.ReadTimeout("slow", request=req)

    r2 = router_with(boom)
    d2 = r2.decide(STATE, "crash_finance", True)
    assert d2.status == "unavailable" and "timeout" in d2.error and d2.chosen_route == "crash_finance"


def test_invalid_shapes_are_not_trusted():
    bad = {"model": "jev-1.13.0", "answers": {"route": {"type": "choice", "choice": "crash_finance", "confidence": 0.9}}, "usage": {}}
    r = router_with(lambda req: httpx.Response(200, json=bad))
    d = r.decide(STATE, "crash_finance", True)
    assert d.status == "invalid_response" and not d.used and d.route is None
    with pytest.raises(ValueError):
        JevRouter.parse_response({"answers": {"route": {"type": "choice", "choice": "sell_the_team", "confidence": 1, "probabilities": {"sell_the_team": 1}}}})
    with pytest.raises(ValueError):
        JevRouter.parse_response([])
