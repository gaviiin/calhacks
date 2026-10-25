"""The 2024 backtest learns only from the past, and the onboarding report says what it learned and what it assumes."""

from __future__ import annotations

from race import backtest, onboarding_report


def test_each_event_is_decided_only_from_earlier_sessions():
    r = backtest.events(strict=True)
    rows = r["rows"]
    assert len(rows) == 93
    first = rows[0]
    assert first["tier"] == "classifier", "the first session has no history: nothing learned can decide it"
    assert all(x["truth"] in backtest.SEVERITIES and x["predicted"] in backtest.SEVERITIES for x in rows)
    s = r["score"]
    assert s["n"] == 93 and 0 <= s["accuracy"] <= 1 and s["learned_n"] + s["classifier_n"] == 93
    assert s["learned_accuracy"] == 1.0, "what the learned tier decided on 2024 (pit stops, infringements) it decided right"
    assert r["score_damage"]["n"] == 24


def test_strict_mode_hides_what_is_only_known_after_the_event():
    strict = {x["case"]: x for x in backtest.events(True)["rows"]}
    recorded = {x["case"]: x for x in backtest.events(False)["rows"]}
    ric = next(k for k in strict if k.startswith("9496-23-L2"))
    assert strict[ric]["predicted"] == "light" and recorded[ric]["predicted"] == "heavy", "the retirement two laps later is what made it heavy"


def test_parts_are_scored_against_what_the_press_reported_destroyed():
    p = backtest.parts()
    assert p["n"] == 6 and [c["crash"] for c in p["crashes"]][0].startswith("press-mel24")
    t = p["score"]["template"]
    assert 0 < t["precision"] <= 1 and 0 < t["recall"] <= 1 and 0 < t["value_recall"] <= 1
    assert p["crashes"][0]["learned"]["basis"].startswith("no earlier crash"), "the first crash has nothing earlier to learn from"


def test_the_onboarding_report_names_every_assumption_and_what_replaces_it():
    r = onboarding_report.build()
    assert r["learned_from"]["events"] == 93 and r["learned_from"]["race_sessions"] > 15
    assert {p["licensed"] for p in r["policies"]} == {True, False}, "some rules are licensed, some stay in shadow"
    assert all(p["licensed"] == (p["cases"] >= 5 and p["lower_bound"] >= 0.75) for p in r["policies"])
    assert len(r["assumptions"]) >= 8 and all(a["replace_with"] for a in r["assumptions"])
    assert r["operations"]["crashes"] == 6


def test_a_teams_records_teach_the_desk_its_hours_lead_times_and_prices():
    from race import team_records

    r = team_records.run(teams=6, write=False)
    t, a = r["today"], r["after_hire"]
    assert r["simulated"] and "not a measurement on Williams" in r["caveat"]
    assert a["hours_error"] < t["hours_error"] and a["lead_error_days"] < t["lead_error_days"]
    assert a["brier"] < t["brier"], "the damage odds learned from the team's reports are better calibrated than the template"
    assert a["parts_precision"] > t["parts_precision"]
    rt, ra = r["with_report"]["today"], r["with_report"]["after_hire"]
    assert ra["season_cost_error"] < rt["season_cost_error"], "with the engineer's report, the team's own prices beat the book"
    assert ra["season_cost_error"] < 0.05


def test_the_simulated_team_never_loses_a_monocoque_to_a_light_brush():
    from race import team_records

    recs = team_records.simulate()
    assert not any("chassis" in x["damage_report"]["parts"] for x in recs if x["band"] == "light")
    assert all(x["work_orders"] for x in recs) and {x["season"] for x in recs} == {2022, 2023, 2024}
