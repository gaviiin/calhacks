"""Race Desk on real races: the money, the clock, crashes, the speed scoreboard, the API."""

import sys
from decimal import Decimal
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from finance.money import to_usd  # noqa: E402
from finance.world import World  # noqa: E402
from racedesk.money import Valuer  # noqa: E402
from racedesk.replay import pit_loss_ms, races, replay, season  # noqa: E402


@pytest.fixture(scope="module")
def spa24():
    return replay(2024, 14)


@pytest.fixture(scope="module")
def sing23():
    return replay(2023, 15)


def order_at(year, rnd, lap):
    race = next(r for r in season(year)["rounds"] if r["round"] == rnd)
    return {int(c): p for c, (p, _) in race["lap_positions"][str(lap)].items()}


def test_data_is_complete():
    assert season(2023)["total_rounds"] == 22 and len(races(2023)) == 22
    assert season(2024)["total_rounds"] == 24 and len(races(2024)) == 24
    assert season(2026)["total_rounds"] == 23 and len(races(2026)) >= 17
    spa = next(r for r in season(2024)["rounds"] if r["round"] == 14)
    rus = next(c for c in spa["classification"] if c["car"] == 63)
    assert rus["position_text"] == "D" and rus["status"] == "Disqualified"


def test_singapore_2023_last_lap_crash_is_priced_exactly():
    w = World()
    v = Valuer(w, season(2023), 15)
    a, b = v.value(order_at(2023, 15, 61)), v.value(order_at(2023, 15, 62))
    # Hamilton inherits P3, so the podium bonuses stay; Russell's own points-finish and top-six bonuses go.
    volta = to_usd(10_000_000, v.fx("EUR"))
    assert a.bonus_usd - b.bonus_usd == volta + 15_000_000
    assert b.prize_ev < a.prize_ev  # fewer points: lower chance of P2 in the championship
    assert sum(b.positions.values()) == pytest.approx(1)


def test_swapping_teammates_is_worth_nothing_to_sponsors():
    v = Valuer(World(), season(2024), 14)
    o = order_at(2024, 14, 40)  # Russell P1, Hamilton P2
    assert o[63] == 1 and o[44] == 2
    assert v.value(v.swapped(o, 44, -1)).total == v.value(o).total


def test_spa_2024_disqualification(spa24):
    assert spa24["final"]["bonus_usd"] == 276_332_000  # the same $2.76m Pit Wall's core books
    assert spa24["road"]["bonus_usd"] == 453_049_000 - 0 or spa24["road"]["bonus_usd"] > spa24["final"]["bonus_usd"]
    assert spa24["totals"]["money_protected"] == spa24["road"]["bonus_usd"] - spa24["final"]["bonus_usd"]
    kinds = [c["kind"] for c in spa24["radio"]]
    assert kinds[0] == "lights_out" and "flag" in kinds and kinds[-1] == "final_classification"
    events = {s["event"]: s for s in spa24["speed"]}
    summons = events["FIA summons: car 63 (George)"]
    assert summons["happened_at"] == "2024-07-28T16:23:00Z" and summons["seconds_to_act"] == 15
    assert summons["usd_protected"] == spa24["totals"]["money_protected"]
    assert events["FIA Final Classification"]["happened_at"] == "2024-07-28T17:56:00Z"


def test_clock_runs_forward_from_the_start(spa24):
    clocks = [x["clock"] for x in spa24["laps"]]
    assert spa24["start_utc"] == "2024-07-28T13:00:00Z" < clocks[0]
    assert clocks == sorted(clocks) and clocks[-1] < "2024-07-28T14:40:00Z"  # flag before the FIA provisional classification


def test_crash_books_damage_and_engine_failure_does_not():
    spa26 = replay(2026, 10)
    crash = spa26["crashes"][0]
    assert crash["status"] == "Collision" and crash["lap"] == 1 and crash["damage_estimate"] == 90_000_000
    assert crash["p_breach_after"] >= crash["p_breach_before"]
    assert crash["p_breach_after_with_final_package"] >= crash["p_breach_after"]
    canada = replay(2026, 5)
    out = next(c for c in canada["radio"] if c["kind"] == "retirement")
    assert "engine" in out["text"] and "D5.1.1.n" in out["text"] and not canada["crashes"]


def test_older_crash_still_gets_a_damage_estimate(sing23):
    c = sing23["crashes"][0]
    assert c["lap"] == 62 and c["status"] == "Accident" and c["damage_estimate"] == 90_000_000 and c["p_breach_after"] is None
    s = next(x for x in sing23["speed"] if x["event"].startswith("Crash"))
    assert "month-end close" in s["manual_baseline"]


def test_pit_loss_is_realistic():
    for year, rnd, lo, hi in ((2024, 14, 15, 25), (2024, 8, 15, 25), (2024, 16, 18, 28)):
        race = next(r for r in season(year)["rounds"] if r["round"] == rnd)
        loss, n = pit_loss_ms(race)
        assert n >= 3 and lo * 1000 <= loss <= hi * 1000, (year, rnd, loss)


def test_api():
    from fastapi.testclient import TestClient

    import finance.api as api

    c = TestClient(api.app)
    assert len(c.get("/api/racedesk/races?season=2026").json()) >= 17
    small = c.get("/api/racedesk/replay/2024/14?detail=false").json()
    assert set(small["laps"][0]) == {"lap", "clock", "total", "delta", "bonus_usd", "prize_ev"}
    assert {"radio", "crashes", "speed", "totals"} <= set(small)
    assert c.get("/api/racedesk/replay/2026/30").status_code == 400
    assert c.get("/api/racedesk/replay/2019/1").status_code == 404
    assert c.get("/api/racedesk/replay/2024/14?team=nobody").status_code == 400


def test_replay_carries_contracts_and_the_field(spa24):
    sp = {s["id"]: s for s in spa24["sponsors"]}
    assert set(sp) >= {"halcyon", "volta", "arcadia", "northwind"}
    win = next(c for c in sp["halcyon"]["clauses"] if c["type"] == "win")
    assert win["usd"] == 200_000_000 and not win["excludes_win"]
    assert len(spa24["field"]) == 20 and spa24["field"][63]["code"] == "RUS"
    assert spa24["classification"][63]["position_text"] == "D"
