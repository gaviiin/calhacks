"""Stage 8: the variance against the press actuals, and the calibration file the price book reads."""

import json
import math

import pytest

from race import close as C
from race import trueup as T
from race.tests.test_close import make_state

ACTUALS = {"primary": "a", "eur_usd": 1.1, "actuals": [
    {"id": "a", "scope": "weekend", "usd": 3.0, "source": "press", "url": "https://example.org/a", "published": "2024-12-11", "verified": True},
    {"id": "b", "scope": "weekend", "eur": 1.0, "source": "press b", "url": "https://example.org/b", "published": "2024-11-06"},
    {"id": "c", "scope": "two weekends", "usd_low": 3, "usd_high": 10, "parts": {"floor": 1, "front_wing": 5}, "source": "TP",
     "url": "https://example.org/c", "published": "2024-11-22"},
]}
TOTALS = {"meeting_key": 1249, "weekend": "São Paulo 2024", "race_cost": {"low_cents": 100, "mid_cents": 200, "high_cents": 400},
          "incidents": [{"severity": "heavy", "mid_cents": 150, "parts": ["floor", "front_wing"]},
                        {"severity": "light", "mid_cents": 50, "parts": ["floor"]}]}


def test_variance_math():
    r = T.true_up(TOTALS, ACTUALS)
    assert r["actual_cents"] == 300 and r["variance_cents"] == 100 and r["variance_pct"] == 0.5 and r["multiplier"] == 1.5
    assert r["inside_band"] is True and r["band_position"] == pytest.approx(200 / 300, abs=1e-4)
    assert r["estimate_by_severity_cents"] == {"heavy": 150, "light": 50}
    b = r["cross_checks"][0]
    assert b["id"] == "b" and b["actual_cents"] == 110 and b["variance_cents"] == -90 and b["inside_band"] is True
    assert r["parts"]["by_part"]["floor"] == {"estimated": 2, "press_upper_bound": 1, "within": False}
    assert r["parts"]["by_part"]["front_wing"]["within"] is True
    assert "+50%" in r["summary"] and "inside the band" in r["summary"]


def test_outside_the_band_and_a_zero_estimate():
    hi = {**ACTUALS, "actuals": [{**ACTUALS["actuals"][0], "usd": 5.0}]}
    r = T.true_up(TOTALS, hi)
    assert r["inside_band"] is False and r["band_position"] > 1
    zero = T.true_up({**TOTALS, "race_cost": {"low_cents": 0, "mid_cents": 0, "high_cents": 0}}, ACTUALS)
    assert zero["variance_pct"] is None and zero["multiplier"] is None and zero["inside_band"] is False


def test_calibration_round_trip(tmp_path):
    path = tmp_path / "price_calibration.json"
    assert T.calibration_factor("heavy", path) == 1.0  # nothing learned yet
    r = {**T.true_up(TOTALS, ACTUALS), "meeting_key": 1249}
    data = T.calibration(r, "close-1249", "ab" * 32, path)
    expected = round(math.exp(0.5 * math.log(1.5)), 4)  # one weekend: credibility 1 / (1 + 1)
    assert data["factors"] == {"all": expected, "heavy": expected, "light": expected}
    assert json.loads(path.read_text()) == data
    assert T.calibration_factor("heavy", path) == expected
    assert T.calibration_factor("moderate", path) == expected  # unseen severity takes 'all'
    T.calibration(r, "close-1249", "ab" * 32, path)  # a re-run replaces the meeting's observation
    assert len(json.loads(path.read_text())["observations"]) == 1
    other = {**r, "meeting_key": 1285, "multiplier": 0.75, "estimate_by_severity_cents": {"heavy": 100}}
    data = T.calibration(other, "close-1285", "cd" * 32, path)
    heavy = math.exp((2 / 3) * (150 * math.log(1.5) + 100 * math.log(0.75)) / 250)
    assert data["factors"]["heavy"] == round(heavy, 4)
    assert data["factors"]["light"] == expected  # light was seen in one weekend only


def test_calibration_factor_ignores_a_broken_file(tmp_path):
    path = tmp_path / "price_calibration.json"
    path.write_text("{not json")
    assert T.calibration_factor("heavy", path) == 1.0
    path.write_text(json.dumps({"factors": {"heavy": -2}}))
    assert T.calibration_factor("heavy", path) == 1.0


def test_the_checked_in_actuals_cite_their_sources():
    a = json.loads(T.ACTUALS[1249].read_text())
    ids = {x["id"] for x in a["actuals"]}
    assert a["primary"] in ids
    for x in a["actuals"]:
        assert x["url"].startswith("https://") and x["published"] and x["source"]
    primary = next(x for x in a["actuals"] if x["id"] == a["primary"])
    assert primary["usd"] == 4_000_000 and "racingnews365.com" in primary["url"]


class Sink:
    def __init__(self):
        self.sims = []
        self.disabled = False

    def sql(self, q):
        return []

    def sim(self, run):
        self.sims.append(run)
        return True


def test_run_trues_up_the_local_snapshot_and_records_a_sim(tmp_path):
    closes = tmp_path / "closes"
    c = C.close_weekend(make_state(), snapshot_dir=closes)
    sink = Sink()
    run = T.run(1249, sink, calibration_path=tmp_path / "cal.json", closes_dir=closes)
    assert run is not None and sink.sims == [run]
    assert run.trigger == "trueup:1249" and run.sim_key.startswith("trueup:1249:") and run.at == "2024-12-11T00:00:00.000Z"
    p = run.payload
    assert p["root_hash"] == c.root_hash and p["close_from"] == "snapshot" and p["snapshot_matches"]
    assert p["estimate_mid_cents"] == c.totals["race_cost"]["mid_cents"] and p["actual_cents"] == 400_000_000
    assert json.loads(run.wire()["payload_json"]) == json.loads(json.dumps(p))  # not cut at the column limit
    assert (tmp_path / "cal.json").exists()


def test_run_refuses_a_tampered_snapshot(tmp_path):
    closes = tmp_path / "closes"
    c = C.close_weekend(make_state(), snapshot_dir=closes)
    path = closes / f"{c.close_key}.json"
    data = json.loads(path.read_text())
    data["leaves"] = data["leaves"][1:]
    path.write_text(json.dumps(data))
    assert T.run(1249, Sink(), calibration_path=tmp_path / "cal.json", closes_dir=closes) is None
