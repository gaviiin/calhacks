"""The races the replay knows, and what in them is real versus synthetic.

A race entry names how to *discover* the OpenF1 session (never a hardcoded session key), which
round it is in the revenue desk's cached results (world/results/<season>.json), and the incident
the fetch script focuses its car_data/location download on. The focus driver is informed by the
public race report cited in `corroboration`; the replay itself attributes the incident from the
data it has at each moment and never from this file.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Corroboration:
    """A public, non-OpenF1 source that confirms what happened. Read by a person; the replay only
    carries the reference and a one-line paraphrase, never the article text."""

    url: str
    publisher: str
    claim: str
    read_on: str  # YYYY-MM-DD the claim was checked against the source


@dataclass(frozen=True)
class IncidentFocus:
    label: str
    driver_number: int
    # The fetch script verifies this flag in race_control and takes the window around its timestamp.
    anchor_flag: str
    anchor_lap: int
    window_before_s: int
    window_after_s: int
    note: str


@dataclass(frozen=True)
class Withdrawal:
    """A car that did not take the start, as known before the start (a team's own announcement).
    It is pre-race knowledge, so the replay may use it from the first record; the timing feed then
    confirms it when the car starts no lap."""

    driver_number: int
    note: str
    known_from: str  # what made it knowable before the start


@dataclass(frozen=True)
class Race:
    race_id: str
    name: str
    season: int
    round: int  # round number in world/results/<season>.json
    slug: str  # event slug in world/results and ingestion/captures
    year: int
    country_name: str
    session_name: str
    cache_dir: str
    sporting_source_date: str
    team_cars_note: str
    incident_focus: tuple[IncidentFocus, ...] = ()
    corroboration: tuple[Corroboration, ...] = ()
    openf1_meeting_key_hint: int | None = None
    pre_race_withdrawals: tuple[Withdrawal, ...] = ()
    scheduled_laps: int | None = None
    extra: dict = field(default_factory=dict)


SAO_PAULO_2024 = Race(
    race_id="2024_sao_paulo_gp",
    name="2024 São Paulo Grand Prix",
    season=2024,
    round=21,
    slug="sao-paulo-grand-prix",
    year=2024,
    country_name="Brazil",
    session_name="Race",
    cache_dir="2024_brazil",
    sporting_source_date="2024-11-03",
    team_cars_note="Meridian Racing mirrors Mercedes' real results: cars 63 (Russell) and 44 (Hamilton). "
    "Car 43 (Colapinto) drove for Williams; the fictional Meridian garage investigation is a demo device.",
    scheduled_laps=69,
    pre_race_withdrawals=(
        Withdrawal(23, "Williams withdrew Albon's car before the start: the chassis damaged in his qualifying crash could not be repaired in time",
                   "the team's announcement before the race (the 2024 classification lists him as did not start)"),
    ),
    incident_focus=(
        IncidentFocus(
            label="car43_lap32_stop",
            driver_number=43,
            anchor_flag="RED",
            anchor_lap=32,
            window_before_s=120,
            window_after_s=20,
            note="car_data and location for car 43 only, from two minutes before the lap-32 red flag to twenty "
            "seconds after it; the rest of the race's car_data is not downloaded",
        ),
    ),
    corroboration=(
        Corroboration(
            url="https://www.formula1.com/en/latest/article/verstappen-wins-chaotic-sao-paulo-grand-prix-after-stunning-recovery-from.1DIc8pzRmGbC3jHJmvtBi1",
            publisher="formula1.com race report",
            claim="Franco Colapinto (Williams, #43) crashed under the Safety Car on lap 32 in wet conditions; the race was red-flagged.",
            read_on="2026-10-24",
        ),
    ),
)

BELGIAN_2024 = Race(
    race_id="2024_belgian_gp",
    name="2024 Belgian Grand Prix",
    season=2024,
    round=14,
    slug="belgian-grand-prix",
    year=2024,
    country_name="Belgium",
    session_name="Race",
    cache_dir="2024_belgium",
    sporting_source_date="2024-07-28",
    team_cars_note="Meridian Racing mirrors Mercedes: car 63 (Russell) won on the road and was disqualified (FIA Doc 44, "
    "underweight car); car 44 (Hamilton) was promoted to the win.",
    corroboration=(
        Corroboration(
            url="https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2024-2043/event/Belgian%20Grand%20Prix",
            publisher="FIA document archive",
            claim="Doc 44: Car 63 disqualified for technical non-compliance (weight); Doc 46 is the final race classification.",
            read_on="2026-10-24",
        ),
    ),
)

RACES: dict[str, Race] = {r.race_id: r for r in (SAO_PAULO_2024, BELGIAN_2024)}


def race(race_id: str) -> Race:
    try:
        return RACES[race_id]
    except KeyError:
        raise KeyError(f"unknown race {race_id!r}; known: {sorted(RACES)}") from None
