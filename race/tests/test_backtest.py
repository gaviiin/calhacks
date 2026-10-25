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
