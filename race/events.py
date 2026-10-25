"""The race desk's unified event: one shape for every OpenF1 fact, replayed or live.

Column names mirror the `race_events`, `car_state` and `race_effects` tables in spacetimedb/src/index.ts;
`to_reducer_args()` renders the snake_case wire form the SpacetimeDB HTTP API expects.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

KINDS = (
    "session_status", "flag", "safety_car", "vsc", "red_flag", "position", "overtake", "pit_stop", "stint", "lap",
    "incident", "penalty", "retirement_suspected", "retirement_confirmed", "standings", "notice",
)
MONEY_KINDS = ("incident", "penalty", "retirement_suspected", "retirement_confirmed", "position", "pit_stop", "standings")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def canonical(s: str) -> str:
    """OpenF1 writes '+00:00'; the module's reducers require the 'Z' form. Idempotent."""
    return iso(parse_iso(s)) if s else s


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


def event_key(source: str, session_key: int, kind: str, driver_number: int, lap: int, at: str, extra: str = "") -> str:
    return hashlib.sha256(f"{source}|{session_key}|{kind}|{driver_number}|{lap}|{at}|{extra}".encode()).hexdigest()


@dataclass
class CarState:
    driver_number: int
    team_name: str
    position: int = 0
    lap: int = 0
    compound: str = ""
    tyre_age: int = 0
    gap_to_leader: str = ""
    last_pit_lap: int = 0
    status: str = "running"  # running | pit | retired_suspected | retired
    updated_at: str = ""

    def __post_init__(self) -> None:
        self.updated_at = canonical(self.updated_at)

    def wire(self) -> dict:
        return asdict(self)


@dataclass
class RaceEvent:
    kind: str
    at: str  # ISO UTC
    session_key: int
    meeting_key: int
    lap: int
    driver_number: int  # 0 = the whole field
    team_name: str
    payload: dict = field(default_factory=dict)
    source: str = "openf1_replay"
    extra_key: str = ""  # disambiguates two facts of the same kind/driver/lap/at (e.g. OpenF1 _key)
    state: CarState | None = None

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"unknown event kind {self.kind!r}")
        self.at = canonical(self.at)

    @property
    def key(self) -> str:
        return event_key(self.source, self.session_key, self.kind, self.driver_number, self.lap, self.at, self.extra_key)

    def wire(self, ingested_at: str | None = None) -> dict:
        return {
            "event_key": self.key, "session_key": self.session_key, "meeting_key": self.meeting_key, "at": self.at,
            "lap": self.lap, "driver_number": self.driver_number, "team_name": self.team_name, "kind": self.kind,
            "payload_json": json.dumps(self.payload, separators=(",", ":"))[:4096], "source": self.source,
            "ingested_at": ingested_at or now_iso(),
        }

    def one_line(self) -> str:
        who = f"#{self.driver_number}" if self.driver_number else "field"
        p = self.payload
        detail = p.get("message") or p.get("summary") or ""
        if self.kind == "position":
            detail = f"P{p.get('from')} -> P{p.get('to')}"
        elif self.kind == "pit_stop":
            detail = f"stop {p.get('stop_duration')}s, lane {p.get('lane_duration')}s"
        elif self.kind == "stint":
            detail = f"{p.get('compound')} (age {p.get('tyre_age_at_start')})"
        elif self.kind == "overtake":
            detail = f"passes #{p.get('overtaken')} for P{p.get('position')}"
        elif self.kind == "standings":
            detail = f"{p.get('team')}: P{p.get('position_start')} -> P{p.get('position_current')}, {p.get('points_start')} -> {p.get('points_current')} pts"
        elif self.kind == "retirement_confirmed":
            detail = f"classified DNF after {p.get('number_of_laps')} laps"
        return f"{self.at[11:19]} L{self.lap:>2} {who:>6} {self.kind:<21} {detail}"


@dataclass
class Effect:
    kind: str  # cost | revenue_projection | bonus | cap_headroom
    bucket: str
    low_cents: int
    mid_cents: int
    high_cents: int
    memo: str
    basis: str  # press | assumption | contract | ladder | policy
    decided_by: str  # policy:<id> | jev | claude:<key> | code
    why: str
    jev: dict = field(default_factory=dict)
    status: str = "proposed"  # proposed | autonomous
    currency: str = "USD"

    def __post_init__(self) -> None:
        if not (self.low_cents <= self.mid_cents <= self.high_cents):
            raise ValueError(f"band must be low <= mid <= high: {self.low_cents} {self.mid_cents} {self.high_cents}")

    def wire(self, event: RaceEvent, n: int) -> dict:
        return {
            "effect_key": f"{event.key}:{n}", "driver_number": event.driver_number, "kind": self.kind, "bucket": self.bucket,
            "low_cents": self.low_cents, "mid_cents": self.mid_cents, "high_cents": self.high_cents, "currency": self.currency,
            "memo": self.memo[:512], "basis": self.basis, "decided_by": self.decided_by,
            "jev_json": json.dumps(self.jev, separators=(",", ":"))[:2048], "why": self.why[:512], "status": self.status,
            "at": event.at,
        }
