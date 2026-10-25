"""Raw OpenF1 records -> normalized, replayable events with stable IDs and no lookahead leaks.

Rules (plan 3C):
- every event carries `event_time_utc` (the source's own timestamp) and gets `observed_at_utc`
  from whoever replays it; they are different things;
- IDs derive from (source, session_key, endpoint, canonical source fields), so a re-fetch or a
  re-run produces the same IDs and consumers can de-duplicate;
- replay order is (event_time_utc, deterministic sequence), ties broken by endpoint rank, driver,
  then id;
- fields a race-day observer could not know at the record's time are masked: a stint's `lap_end`
  (the future), a lap's duration and sector times (known only when the lap ends, so they are a
  separate `lap_complete` event), and `session_result` (post-session validation only, never
  replayed).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Iterable

from .openf1_client import iso_utc, parse_openf1_time

# Ranking for ties at the same timestamp: environment first, then official messages, then cars.
ENDPOINT_RANK = {
    "weather": 0,
    "race_control": 1,
    "pit": 2,
    "stint_start": 3,
    "lap_start": 4,
    "lap_complete": 5,
    "position": 6,
    "intervals": 7,
    "location": 8,
    "car_data": 9,
    "corroboration": 10,
    "fia_document": 11,
}

# The replay never sees these endpoints (plan 3B/3C).
NEVER_REPLAYED = {"session_result", "drivers", "sessions", "meetings", "starting_grid"}


@dataclass(frozen=True)
class NormalizedEvent:
    event_id: str
    source_system: str
    endpoint: str
    source_url: str
    event_time_utc: str
    seq: int
    driver_number: int | None
    lap_number: int | None
    payload: dict[str, Any]
    masked_fields: tuple[str, ...] = ()
    record_id: str | None = None

    def to_json(self) -> dict:
        return {
            "event_id": self.event_id, "source_system": self.source_system, "endpoint": self.endpoint,
            "source_url": self.source_url, "event_time_utc": self.event_time_utc, "seq": self.seq,
            "driver_number": self.driver_number, "lap_number": self.lap_number, "payload": self.payload,
            "masked_fields": list(self.masked_fields), "record_id": self.record_id,
        }

    @classmethod
    def from_json(cls, d: dict) -> "NormalizedEvent":
        return cls(d["event_id"], d["source_system"], d["endpoint"], d["source_url"], d["event_time_utc"], d["seq"],
                   d.get("driver_number"), d.get("lap_number"), d["payload"], tuple(d.get("masked_fields", [])), d.get("record_id"))


def _digest(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def event_id(source: str, session_key: int, endpoint: str, *canonical: Any) -> str:
    return f"{source}:{session_key}:{endpoint}:{_digest(*canonical)}"


def _utc(ts: str) -> str:
    return iso_utc(parse_openf1_time(ts))


def _strip(row: dict, *drop: str) -> dict:
    return {k: v for k, v in row.items() if k not in drop and k not in ("session_key", "meeting_key")}


def normalize_rows(endpoint: str, rows: Iterable[dict], session_key: int, source_url: str, source: str = "openf1") -> list[NormalizedEvent]:
    """Normalize one endpoint's rows. Unknown endpoints are kept as-is with their `date` as event time."""
    if endpoint in NEVER_REPLAYED:
        return []
    out: list[NormalizedEvent] = []
    for row in rows:
        if endpoint == "laps":
            out.extend(_laps(row, session_key, source_url, source))
        elif endpoint == "stints":
            out.append(_stint(row, session_key, source_url, source))
        elif endpoint == "race_control":
            out.append(NormalizedEvent(
                event_id(source, session_key, endpoint, row["date"], row.get("category"), row.get("message"), row.get("driver_number")),
                source, endpoint, source_url, _utc(row["date"]), 0, row.get("driver_number"), row.get("lap_number"),
                _strip(row, "date"), record_id=None))
        elif endpoint in ("position", "intervals", "location", "car_data", "weather", "pit"):
            drv = row.get("driver_number")
            lap = row.get("lap_number")
            canonical: tuple = (row["date"], drv) if endpoint != "weather" else (row["date"],)
            if endpoint == "position":
                canonical = (row["date"], drv, row.get("position"))
            out.append(NormalizedEvent(event_id(source, session_key, endpoint, *canonical), source, endpoint, source_url,
                                       _utc(row["date"]), 0, drv, lap, _strip(row, "date")))
        else:
            ts = row.get("date") or row.get("date_start")
            if not ts:
                continue
            out.append(NormalizedEvent(event_id(source, session_key, endpoint, json.dumps(row, sort_keys=True)), source, endpoint,
                                       source_url, _utc(ts), 0, row.get("driver_number"), row.get("lap_number"), _strip(row, "date")))
    return out


def _laps(row: dict, session_key: int, source_url: str, source: str) -> list[NormalizedEvent]:
    """A lap record is two observations: the lap started (known at date_start) and the lap was
    completed (known at date_start + lap_duration, when the sector and lap times exist)."""
    drv, lap = row["driver_number"], row["lap_number"]
    if not row.get("date_start"):
        return []
    start = parse_openf1_time(row["date_start"])
    events = [NormalizedEvent(
        event_id(source, session_key, "lap_start", drv, lap), source, "lap_start", source_url, iso_utc(start), 0, drv, lap,
        {"driver_number": drv, "lap_number": lap, "is_pit_out_lap": row.get("is_pit_out_lap", False)},
        masked_fields=("lap_duration", "duration_sector_1", "duration_sector_2", "duration_sector_3", "i1_speed", "i2_speed", "st_speed",
                       "segments_sector_1", "segments_sector_2", "segments_sector_3"))]
    if row.get("lap_duration"):
        end = start + timedelta(seconds=float(row["lap_duration"]))
        events.append(NormalizedEvent(
            event_id(source, session_key, "lap_complete", drv, lap), source, "lap_complete", source_url, iso_utc(end), 0, drv, lap,
            {k: v for k, v in row.items() if k not in ("session_key", "meeting_key", "date_start", "segments_sector_1",
                                                     "segments_sector_2", "segments_sector_3")}))
    return events


def _stint(row: dict, session_key: int, source_url: str, source: str) -> NormalizedEvent:
    """A stint becomes known when it starts; its end lap is the future and is masked."""
    return NormalizedEvent(
        event_id(source, session_key, "stint_start", row["driver_number"], row.get("stint_number"), row.get("lap_start")),
        source, "stint_start", source_url, "",  # time is attached later from the driver's lap_start event
        0, row["driver_number"], row.get("lap_start"),
        {k: v for k, v in row.items() if k not in ("session_key", "meeting_key", "lap_end")}, masked_fields=("lap_end",))


def attach_stint_times(events: list[NormalizedEvent], session_start_utc: str) -> list[NormalizedEvent]:
    """Stints carry lap numbers, not times: time them by the driver's lap_start of `lap_start`
    (stint 1 at the session start). Stints whose lap never started are dropped (unknown time)."""
    lap_starts = {(e.driver_number, e.lap_number): e.event_time_utc for e in events if e.endpoint == "lap_start"}
    out = []
    for e in events:
        if e.endpoint != "stint_start":
            out.append(e)
            continue
        t = lap_starts.get((e.driver_number, e.lap_number))
        if t is None and e.lap_number == 1:
            t = session_start_utc
        if t is None:
            continue
        out.append(NormalizedEvent(e.event_id, e.source_system, e.endpoint, e.source_url, t, 0, e.driver_number, e.lap_number,
                                   e.payload, e.masked_fields, e.record_id))
    return out


def order_events(events: Iterable[NormalizedEvent]) -> list[NormalizedEvent]:
    """Deterministic replay order with de-duplication by event_id; `seq` is the final position."""
    seen: set[str] = set()
    unique = []
    for e in events:
        if e.event_id in seen or not e.event_time_utc:
            continue
        seen.add(e.event_id)
        unique.append(e)
    unique.sort(key=lambda e: (e.event_time_utc, ENDPOINT_RANK.get(e.endpoint, 50), e.driver_number or 0, e.event_id))
    return [NormalizedEvent(e.event_id, e.source_system, e.endpoint, e.source_url, e.event_time_utc, i, e.driver_number,
                            e.lap_number, e.payload, e.masked_fields, e.record_id) for i, e in enumerate(unique)]


def write_jsonl(path, events: Iterable[NormalizedEvent]) -> int:
    n = 0
    with open(path, "w") as f:
        for e in events:
            f.write(json.dumps(e.to_json(), separators=(",", ":"), sort_keys=True) + "\n")
            n += 1
    return n


def read_jsonl(path) -> list[NormalizedEvent]:
    with open(path) as f:
        return [NormalizedEvent.from_json(json.loads(line)) for line in f if line.strip()]


@dataclass
class Slice:
    """A race's replayable slice plus the metadata the replay needs (drivers, session, windows)."""

    meta: dict
    events: list[NormalizedEvent] = field(default_factory=list)
