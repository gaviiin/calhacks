from pathlib import Path

import pytest

from race.openf1 import load_car_data
from race.telemetry import detect_all

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

# Every hard stop of a team car in the four fixture sessions, and nothing else: a garage or pit-lane stop, a
# safety-car crawl or a car that never started must not fire.
EXPECTED = {
    11291: [(23, "2026-05-24T20:25:37", "freeze")],  # Canada 2026: Albon hit by Piastri, the stream freezes
    9693: [(55, "2025-03-16T04:20:27", "stop")],  # Melbourne 2025: Sainz, lap 1 under the safety car
    9627: [(43, "2024-11-03T10:39:00", "stop"), (23, "2024-11-03T11:57:19", "stop")],  # São Paulo qualifying
    9636: [(43, "2024-11-03T16:36:55", "stop")],  # São Paulo race: Colapinto, red flag, never named
}


@pytest.fixture(scope="module")
def stops():
    return {k: detect_all(load_car_data(k, FIXTURES)) for k in EXPECTED}


@pytest.mark.parametrize("session", sorted(EXPECTED))
def test_detect_all_finds_exactly_the_crashes(stops, session):
    got = [(s["car"], s["at"][:19], s["signature"]) for s in stops[session]]
    assert got == EXPECTED[session]


def test_stop_readings(stops):
    sainz = stops[9693][0]
    assert sainz["peak_kph"] == 119 and sainz["decel_g"]
    albon_q3 = stops[9627][1]
    assert albon_q3["peak_kph"] == 315 and albon_q3["impact_kph"] == 315
    assert stops[9627][0]["peak_kph"] == 166 and stops[9636][0]["peak_kph"] == 188
    freeze = stops[11291][0]
    assert freeze["peak_kph"] >= 100 and freeze["decel_g"] is None


def test_albon_did_not_start_the_race_so_nothing_fires(stops):
    assert all(s["car"] != 23 for s in stops[9636])
