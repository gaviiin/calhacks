import json
from pathlib import Path

from src.classify import classify_title, parse_published_at, weekend_timeline

CAPTURES = Path(__file__).resolve().parent.parent / "captures"


def capture(prefix: str) -> dict:
    return json.loads(next(CAPTURES.glob(f"{prefix}-*.json")).read_text())


def test_fia_times_are_central_european_local_time():
    # Summer: CEST (UTC+2). Spa 2024 provisional classification.
    assert parse_published_at("28.07.24 16:40 CET") == "2024-07-28T14:40:00Z"
    # Still CEST on 22 Oct 2023 (DST ended 29 Oct). Austin 2023 provisional.
    assert parse_published_at("22.10.23 23:01 CET") == "2023-10-22T21:01:00Z"
    # Winter: CET (UTC+1).
    assert parse_published_at("08.12.24 16:30 CET") == "2024-12-08T15:30:00Z"
    assert parse_published_at("") is None
    assert parse_published_at("yesterday") is None


def test_classifies_real_titles():
    assert classify_title("Doc 41 - Provisional Race Classification").kind == "provisional_race_classification"
    assert classify_title("Doc 46 - Final Race Classification").kind == "final_race_classification"
    assert classify_title("Final Qualifying Classification").kind == "qualifying_classification"
    assert classify_title("Provisional Sprint Classification").kind == "provisional_sprint_classification"

    spa = classify_title("Doc 44 - Infringement - Car 63 - Technical non-compliance (Weight)")
    assert (spa.kind, spa.cars, spa.likely_outcome, spa.outcome_confirmed) == (
        "infringement", (63,), "disqualification", False,
    )

    austin = classify_title("Infringement - Car 44 - Technical non-compliance (Plank)")
    assert austin.cars == (44,) and austin.likely_outcome == "disqualification"

    summons = classify_title("Doc 43 - Summons - Car 63 - Technical Regulations")
    assert summons.kind == "summons" and summons.cars == (63,)

    impeding = classify_title("Doc 32 - Infringement - Car 24 - Impeding of Car 1")
    assert impeding.cars == (24,) and impeding.likely_outcome == "penalty"

    assert classify_title("Doc 40 - Infringement - Race Deleted Lap Times").likely_outcome is None
    assert classify_title("Decision - Car 18 - Not entering Pit Lane").kind == "decision"


def test_spa_2024_weekend_in_real_order():
    items = capture("2024-belgian-grand-prix")["items"]
    race = [r for r in weekend_timeline(items) if r["published_at_utc"] >= "2024-07-28T14:00:00Z"]
    kinds = [r["kind"] for r in race if r["kind"] != "infringement" or r["cars"]]
    # Provisional classification, then the summons, then the infringement, then the final classification.
    assert kinds == ["provisional_race_classification", "summons", "infringement", "final_race_classification"]
    infringement = next(r for r in race if r["kind"] == "infringement" and r["cars"])
    assert infringement["cars"] == [63] and infringement["published_at_utc"] == "2024-07-28T16:53:00Z"


def test_austin_2023_two_cars_flagged():
    flagged = {
        car
        for r in weekend_timeline(capture("2023-united-states-grand-prix")["items"])
        if r["likely_outcome"] == "disqualification"
        for car in r["cars"]
    }
    assert flagged == {44, 16}
