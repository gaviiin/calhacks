"""Cost cap strategy simulator: the rules exactly as written, the plan's arithmetic, the simulation, the decision."""

import csv
import os
import re
import sys
from decimal import Decimal
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from capsim import regulations as R  # noqa: E402
from capsim.assumptions import Assumptions  # noqa: E402
from capsim.decide import Option, Standings, evaluate, headroom, pu_allocation  # noqa: E402
from capsim.plan import CALENDAR_2026, Plan, actuals  # noqa: E402
from capsim.sim import Scenario, forecast  # noqa: E402
from capsim.sources import cost_cap_desk_actuals, load  # noqa: E402

FAST = Assumptions(runs=800)


# ---------------------------------------------------------------------------- regulations


def test_cap_2026_by_calendar():
    assert R.cost_cap(2026, 23) == 215_000_000  # 2026 actually has 23 rounds
    assert R.cost_cap(2026, 18) == 215_000_000  # no reduction for fewer races (D4.1.2.a)
    assert R.cost_cap(2026, 24) == 215_000_000
    assert R.cost_cap(2026, 25) == 216_800_000  # D4.1.2.b
    assert R.cost_cap(2026, 26) == 218_600_000
    with pytest.raises(ValueError):
        R.cost_cap(2026, 23, indexation=0.03)  # Indexation is defined only from FY2027


def test_cap_2021_25_rules_for_comparison():
    with pytest.raises(ValueError):
        R.rules_for(2023)  # Issue 22's cap text covers FY2024 onwards only
    assert R.cost_cap(2024, 20, cancelled_late=1) == 135_000_000  # a late cancellation counts as raced (ISS22 2.3)
    assert R.cost_cap(2026, 22, cancelled_late=1) == 215_000_000  # no such rule, and no effect, in 2026
    assert R.cost_cap(2024, 21) == 135_000_000
    assert R.cost_cap(2024, 20) == 133_200_000  # fell with fewer races under ISS22 2.3(a)(ii)
    assert R.cost_cap(2024, 24) == 140_400_000
    assert R.cost_cap(2024, 24, indexation=Decimal("0.05")) == 147_420_000


def test_breach_lines_are_exact():
    cap = 215_000_000
    assert R.classify(2026, cap, cap).category == "compliant"
    assert R.classify(2026, cap + 1, cap).category == "minor_overspend"
    line = R.classify(2026, cap, cap).material_line
    assert line == 219_300_000  # 2% of 215m = 4.3m
    assert R.classify(2026, line - 1, cap).category == "minor_overspend"
    assert R.classify(2026, line, cap).category == "material_overspend"  # "by 2% or more"
    # never round before comparing: 2% of this cap is 4,300,000.4, so 4,300,000 over is still minor
    odd = 215_000_020
    assert R.classify(2026, odd + 4_300_000, odd).category == "minor_overspend"
    assert R.classify(2026, odd + 4_300_001, odd).category == "material_overspend"
    assert R.classify(2026, odd, odd).material_line == odd + 4_300_001
    # the same overspend under the 2021-25 rules (5%) is still minor
    assert R.classify(2024, 141_000_000, 135_000_000).category == "minor_overspend"
    assert R.classify(2024, 141_750_000, 135_000_000).category == "material_overspend"


def test_red_bull_2021_overspend_would_still_be_minor_in_2026():
    pct = Decimal("0.016")  # 1.6% of the cap
    assert R.classify(2026, int(215_000_000 * (1 + pct)), 215_000_000).category == "minor_overspend"
    assert R.classify(2026, int(215_000_000 * Decimal("1.021")), 215_000_000).category == "material_overspend"


def test_adjustments():
    assert R.adjustments(2026, sprints=6).total == 0
    assert R.adjustments(2026, sprints=8).sprint == 600_000  # only beyond six (D6.1.1.p)
    assert R.adjustments(2024, sprints=6).sprint == 1_800_000  # every sprint under ISS22 4.1(l)
    assert R.adjustments(2026, 6, pu_integration_this_year=3_000_000).pu_integration == 3_000_000
    assert R.adjustments(2027, 6, unused_carry=5_000_000).unused_carry == 2_000_000  # capped (D6.1.1.n)
    assert R.adjustments(2027, 6, pu_integration_this_year=4_000_000).pu_integration == 4_000_000  # rest of q.i plus part of q.iii
    assert R.adjustments(2028, 6, pu_integration_this_year=3_000_000).pu_integration == 3_000_000
    with pytest.raises(ValueError):
        R.adjustments(2027, 6, pu_integration_this_year=6_000_001)
    with pytest.raises(ValueError):
        R.adjustments(2026, 6, pu_integration_this_year=3_000_001)
    with pytest.raises(ValueError):
        R.adjustments(2025, 6, pu_integration_this_year=1)
    with pytest.raises(ValueError):
        R.adjustments(2026, 6, unused_carry=1)  # no carry-forward into 2026
    with pytest.raises(ValueError):
        R.adjustments(2026, 6, tyre_test_days=2)  # amount set by Determination: must be supplied


def test_pu_adjustment_defaults_to_the_undeclared_split():
    p = Plan()
    sc = Scenario(9, actuals(p, 9), set())  # nothing declared
    assert sc.pu_integration_2026 == R.PU_INTEGRATION_DEFAULT_2026 == 1_500_000
    assert forecast(p, sc, FAST)["adjustments"]["pu_integration"] == 1_500_000


def test_sanctions_follow_d10():
    assert R.SANCTIONS["compliant"]["mandatory"] == []
    assert any("Financial Penalty" in s for s in R.SANCTIONS["minor_overspend"]["mandatory"])
    assert any("points deduction" in s for s in R.SANCTIONS["material_overspend"]["mandatory"])
    assert not any("points" in s for s in R.SANCTIONS["minor_overspend"]["mandatory"])
    for cat in ("minor_overspend", "material_overspend"):
        assert any("enhanced monitoring" in s for s in R.SANCTIONS[cat]["possible"])


def _text_dir() -> Path | None:
    for d in (os.environ.get("CAPSIM_REG_TEXT"), REPO / "research" / "fia"):
        if d and (Path(d) / "secD_iss08.txt").exists():
            return Path(d)
    return None


@pytest.mark.skipif(_text_dir() is None, reason="regulation text not present (research/fia on the cost-cap-desk branch)")
def test_every_quote_is_verbatim_in_the_regulation_text():
    d = _text_dir()
    files = {"SECD-ISS08": "secD_iss08.txt", "ISS22": "finreg_iss22_2024.txt", "SECA-ISS02": "secA_iss02.txt"}
    squash = {k: re.sub(r"\s+", "", (d / f).read_text()) for k, f in files.items()}  # the PDF extraction splits words with spaces
    missing = []
    for rs in (R.SECD_ISS08, R.ISS22):
        for key, p in rs.provisions.items():
            if re.sub(r"\s+", "", p.quote) not in squash[p.source]:
                missing.append(f"{rs.rule_set}.{key} ({p.article})")
    assert not missing, missing


# ---------------------------------------------------------------------------- plan


def test_calendar_2026():
    assert len(CALENDAR_2026) == 23 and sum(r.sprint for r in CALENDAR_2026) == 6
    assert [r.round for r in CALENDAR_2026] == list(range(1, 24))
    assert all(a.day < b.day for a, b in zip(CALENDAR_2026, CALENDAR_2026[1:]))
    assert not any("Saudi" in r.name for r in CALENDAR_2026)
    assert any("Sepang" in r.name for r in CALENDAR_2026)


def test_plan_adds_up():
    p = Plan()
    assert p.annual_budget() == sum(p.summary()["by_category"].values())
    assert sum(p.crash_reserve_in(m) for m in range(1, 13)) == p.crash_reserve
    assert p.annual_budget({"U5"}) - p.annual_budget() == 2_400_000
    act = actuals(p, 9)
    assert sorted(act) == list(range(1, 10))


# ---------------------------------------------------------------------------- simulation


def base(include=(), pu=0, as_of=9, **kw):
    p = Plan()
    return p, Scenario(as_of, actuals(p, as_of), set(include), pu, label="t", **kw)


def test_forecast_is_deterministic_and_coherent():
    p, sc = base()
    f1, f2 = forecast(p, sc, FAST), forecast(p, sc, FAST)
    assert f1 == f2
    pr = f1["probability"]
    assert abs(pr["compliant"] + pr["minor_overspend"] + pr["material_overspend"] - 1) < 1e-9
    rc = f1["relevant_costs"]
    assert rc["p5"] <= rc["p50"] <= rc["p95"] <= rc["max"]
    assert f1["cap"] == 215_000_000 and f1["adjustments"]["total"] == 0


def test_scenarios_are_paired_run_by_run():
    p, sc = base()
    _, sc5 = base(["U5"])
    f0 = forecast(p, sc, FAST, keep_runs=True)["_relevant"]
    f1 = forecast(p, sc5, FAST, keep_runs=True)["_relevant"]
    diffs = [b - a for a, b in zip(f0, f1)]
    assert all(1_500_000 < d < 4_500_000 for d in diffs)  # only the package's own (overrun-adjusted) cost differs


def test_pu_adjustment_moves_every_run_by_exactly_its_amount():
    p, sc = base(["U5"])
    _, sc3 = base(["U5"], pu=3_000_000)
    f0 = forecast(p, sc, FAST, keep_runs=True)["_relevant"]
    f3 = forecast(p, sc3, FAST, keep_runs=True)["_relevant"]
    assert all(a - b == 3_000_000 for a, b in zip(f0, f3))


def test_closed_year_has_no_uncertainty():
    p, sc = base(as_of=12)
    f = forecast(p, sc, FAST)
    assert f["relevant_costs"]["p5"] == f["relevant_costs"]["max"] == f["actuals_to_date"]


def test_more_crashes_more_breach_risk():
    p, sc = base(["U5"])
    calm = Assumptions(runs=800)
    calm.crash.incidents_per_race = 0.1
    wild = Assumptions(runs=800)
    wild.crash.incidents_per_race = 0.8
    assert forecast(p, sc, calm)["probability"]["breach"] < forecast(p, sc, wild)["probability"]["breach"]


def test_assumptions_validation():
    with pytest.raises(ValueError):
        Assumptions.from_dict({"crash": {"nope": 1}})
    with pytest.raises(ValueError):
        Assumptions.from_dict({"runs": 5})


# ---------------------------------------------------------------------------- decisions


def test_final_upgrade_depends_on_the_pu_allocation():
    p, sc = base(pu=0)
    tight = Standings()  # the hand-made close fight, where points can still move Meridian up
    no = evaluate(p, sc, Option("U5"), tight, a=Assumptions(runs=1500))
    _, sc3 = base(pu=3_000_000)
    yes = evaluate(p, sc3, Option("U5"), tight, a=Assumptions(runs=1500))
    assert no["verdict"] == "do_not" and any("D10.3.4" in r for r in no["reasons"])
    assert yes["verdict"] == "do_it"
    assert no["delta"]["breach_probability"] > yes["delta"]["breach_probability"]
    assert no["delta"]["carry_forward_room_2027"] <= 0  # spending more never adds carry-forward
    for r in (no, yes):
        assert abs(sum(r["with"]["positions"].values()) - 1) < 1e-9


def test_worthless_upgrade_is_never_worth_it():
    p, sc = base(pu=3_000_000)
    r = evaluate(p, sc, Option("U5", points_per_race=0, points_sd_per_race=0), a=FAST)
    # no points gained; any change in prize money can only come from points deducted for a material overspend
    assert r["delta"]["expected_prize_money"] <= 0 and r["verdict"] == "do_not"


def test_headroom_and_allocation():
    p, sc = base()
    h = headroom(p, sc, FAST, 0.20)
    assert 0 < h["extra_spend_allowed"] < 4_000_000 and h["breach_at_that_spend"] <= 0.20
    tight = headroom(p, base(["U5"])[1], FAST, 0.05)
    assert tight["extra_spend_allowed"] == 0 and "cuts" in tight["note"]
    opts = pu_allocation(p, base(["U5"])[1], FAST)
    risks = [o["p_breach_2026"] for o in opts]
    assert risks == sorted(risks, reverse=True)  # more of the USD 3m in 2026 -> less 2026 risk
    assert all(o["to_2026"] + o["to_2027"] == 3_000_000 for o in opts)


# ---------------------------------------------------------------------------- Cost Cap Desk adapter


def test_cost_cap_desk_truth_file(tmp_path):
    path = tmp_path / "truth_2026.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["gl_line_id", "category_code", "relevant_usd_minor", "period_key"])
        w.writeheader()
        for m in range(1, 10):
            w.writerow({"gl_line_id": f"g{m}a", "category_code": "RELEVANT", "relevant_usd_minor": 1_500_000_000, "period_key": f"2026-{m:02d}"})
            w.writerow({"gl_line_id": f"g{m}b", "category_code": "CATERING", "relevant_usd_minor": 0, "period_key": f"2026-{m:02d}"})
        w.writerow({"gl_line_id": "old", "category_code": "RELEVANT", "relevant_usd_minor": 999, "period_key": "2025-12"})
    act = cost_cap_desk_actuals(9, path)
    assert act == {m: 15_000_000 for m in range(1, 10)}
    plan, act2, meta = load("cost_cap_desk", 9, path=path)
    assert act2 == act and meta["source"] == "cost_cap_desk" and meta["run_rate_vs_meridian_plan"] < 1
    f = forecast(plan, Scenario(9, act2, set(), label="k"), FAST)
    assert f["actuals_to_date"] == 135_000_000
    with pytest.raises(ValueError):
        cost_cap_desk_actuals(10, path)  # October not in the file


# ---------------------------------------------------------------------------- HTTP


def test_api(monkeypatch):
    from fastapi.testclient import TestClient

    import finance.api as api

    c = TestClient(api.app)
    assert c.get("/api/capsim/rules").json()["2026"]["material_line"] == 219_300_000
    assert c.get("/api/capsim/plan").json()["races"] == 23
    small = {"assumptions": {"runs": 500}}
    f = c.post("/api/capsim/forecast", json=small).json()
    assert abs(sum(b["share"] for b in f["histogram"]) - 1) < 1e-9
    d = c.post("/api/capsim/decide", json={**small, "pu_integration_2026": 3_000_000}).json()
    assert d["verdict"] in ("do_it", "do_not") and "D10.3" in d["regulations"]["material"]["article"]
    assert c.post("/api/capsim/decide", json={**small, "include": ["U5"]}).status_code == 400
    assert c.post("/api/capsim/forecast", json={"include": ["U1"]}).status_code == 400  # delivered, not proposed
    assert c.post("/api/capsim/forecast", json={"extra_spend": {"3": 1}}).status_code == 400  # a closed month
    assert c.post("/api/capsim/pu-allocation", json=small).json()["deadline"] == "declare by 30 November 2026"
    assert c.get("/api/capsim/sources").json()["illustrative"]


def test_real_2026_table_makes_the_upgrade_worthless():
    from capsim.decide import default_standings

    st = default_standings(9)
    assert st.us == "Mercedes" and "real 2026 standings" in st.source
    assert max(st.teams, key=lambda t: t.points).name == "Mercedes"
    _, sc3 = base(pu=3_000_000)
    r = evaluate(Plan(), sc3, Option("U5"), st, a=FAST)
    assert r["verdict"] == "do_not" and r["delta"]["expected_prize_money"] < 1_000  # P1 already safe: points buy nothing
