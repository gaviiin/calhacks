from race import cap_forecast
from race.events import Entry, EntryLine
from race.tests.test_season_sim import state
from race.weekend import Weekend


def _with_cost(usd: float):
    st = state()
    st.session = {"session_key": 9636, "date_start": "2024-11-03T15:30:00+00:00"}
    c = int(usd * 100)
    st.entries["e"] = Entry(entry_key="e", incident_key="k", memo="crash damage", effective_date="2024-11-03", recognition="first_use",
                            cap_relevant=True, lines=[EntryLine("6050", debit_cents=c), EntryLine("2100", credit_cents=c)])
    return st


def test_cap_levels_and_interface():
    assert cap_forecast.cap_level_cents(2024) == 140_400_000 * 100  # Issue 22 Art. 2.3(a)(iii), 24 Competitions
    assert cap_forecast.cap_level_cents(2026) == 215_000_000 * 100
    st = state()
    assert 0 < cap_forecast.relevant_before_cents(st) < cap_forecast.cap_level_cents(2024)


def test_overspend_rises_with_the_weekend_cost():
    p = [cap_forecast.forecast(_with_cost(x))["p_overspend"] for x in (1e6, 3e6, 3.9e6, 7e6)]
    assert p == sorted(p) and p[0] < p[-1]
    f = cap_forecast.forecast(_with_cost(12e6))
    assert f["p_material"] > 0 and f["p_overspend"] > 0.5


def test_sao_paulo_forces_a_small_deferral():
    f = cap_forecast.forecast(_with_cost(3.92e6))
    assert f["weekend_source"] == "ledger"
    assert 0.10 < f["p_overspend"] and f["p_overspend_after_defer"] <= 0.10
    assert 100_000 * 100 <= f["defer_cents"] <= 900_000 * 100 and f["defer_covered"]
    assert f["adjustments_cents"] == 6 * 300_000 * 100
    assert f["year_end"]["p10_cents"] <= f["year_end"]["p50_cents"] <= f["year_end"]["p90_cents"]
    assert "rejected" in f["context"] and "Art. 2.3" in f["cap_basis"]


def test_the_replayed_weekend():
    w = Weekend(1249, pace=0, sink=None, offline=True, forecast=False, quiet=True)
    w.run()
    sims = w.state.sims
    assert sims[0].trigger == "baseline" and sims[-1].trigger.startswith("result:")
    assert sims[0].payload["p_target"] - sims[-1].payload["p_target"] > 0.3 and sims[-1].payload["p_target"] < 0.10
    cap = sims[-1].payload["cap"]
    assert cap["p_overspend"] > sims[0].payload["cap"]["p_overspend"]
    assert 100_000 * 100 <= cap["defer_cents"] <= 900_000 * 100, cap
