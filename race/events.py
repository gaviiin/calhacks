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
    "incident", "penalty", "retirement_suspected", "retirement_confirmed", "standings", "notice", "car_stopped",
)
MONEY_KINDS = ("incident", "penalty", "retirement_suspected", "retirement_confirmed", "position", "pit_stop", "standings",
               "car_stopped")


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
            detail = p.get("summary") or "did not start" if p.get("dns") else f"classified DNF after {p.get('number_of_laps')} laps"
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
    status: str = "proposed"  # proposed | needs_person | autonomous | confirmed | corrected
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


# ---------------------------------------------------------------------- the race-day flow
# One row shape per stage after the tape: an incident whose belief evolves (log), the actions it sets off
# (respond), the provisional entries (account), the questions for a person (ask), the season re-run (re-plan)
# and the sealed weekend (close). Each mirrors a pit-wall table; `wire()` is the reducer's argument.

def _j(v) -> str:
    return json.dumps(v, separators=(",", ":"), default=str)


INCIDENT_STATUSES = ("suspected", "corroborated", "confirmed", "assessed", "closed")


@dataclass
class Incident:
    """One crash or stoppage of one of our cars, across every message about it. `belief` is what we think now:
    {"severity": {...P}, "parts": {...P}, "impact_kph": int, "where": str, "cause": str, "out_of_session": bool}.
    Every change bumps `version` and writes a race_beliefs row (valid time = `at`, system time = recorded_at)."""

    incident_key: str
    meeting_key: int
    session_key: int
    driver_number: int
    team_name: str
    first_seen_at: str
    status: str = "suspected"
    version: int = 1
    belief: dict = field(default_factory=dict)
    evidence: list[dict] = field(default_factory=list)  # [{"event_key", "kind", "at", "source", "note"}]
    updated_at: str = ""
    cause: str = ""  # what changed in this version, one line

    def __post_init__(self) -> None:
        if self.status not in INCIDENT_STATUSES:
            raise ValueError(f"unknown incident status {self.status!r}")
        self.first_seen_at = canonical(self.first_seen_at)
        self.updated_at = canonical(self.updated_at or self.first_seen_at)

    def wire(self) -> dict:
        return {"incident_key": self.incident_key, "meeting_key": self.meeting_key, "session_key": self.session_key,
                "driver_number": self.driver_number, "team_name": self.team_name, "first_seen_at": self.first_seen_at,
                "status": self.status, "version": self.version, "belief_json": _j(self.belief)[:4096],
                "evidence_json": _j(self.evidence[-24:])[:4096], "updated_at": self.updated_at, "cause": self.cause[:512]}


ACTION_KINDS = ("garage_check", "spares_reserve", "work_order", "freight", "hand_carry", "withdraw_car", "parc_ferme_list",
                "pu_check", "td017_move", "fia_notice", "evidence_pack")
ACTION_STATUSES = ("auto", "awaiting_approval", "approved", "rejected", "done", "cancelled")


@dataclass
class Action:
    """Something the playbook sets off. Reversible, internal actions run on their own (`auto`); anything
    outward-facing or irreversible waits for the role named in `owner_role`."""

    action_key: str
    incident_key: str
    kind: str
    title: str
    detail: dict = field(default_factory=dict)
    due_at: str = ""
    status: str = "auto"
    owner_role: str = ""
    reversible: bool = True
    outward: bool = False
    decided_by: str = "code"
    updated_at: str = ""

    def __post_init__(self) -> None:
        if self.kind not in ACTION_KINDS:
            raise ValueError(f"unknown action kind {self.kind!r}")
        if self.status not in ACTION_STATUSES:
            raise ValueError(f"unknown action status {self.status!r}")
        self.due_at = canonical(self.due_at) if self.due_at else ""
        self.updated_at = canonical(self.updated_at) if self.updated_at else now_iso()

    def wire(self) -> dict:
        return {"action_key": self.action_key, "incident_key": self.incident_key, "kind": self.kind, "title": self.title[:256],
                "detail_json": _j(self.detail)[:4096], "due_at": self.due_at, "status": self.status, "owner_role": self.owner_role,
                "reversible": self.reversible, "outward": self.outward, "decided_by": self.decided_by, "updated_at": self.updated_at}


RECOGNITION = ("first_use", "incurred", "excluded", "already_expensed")


@dataclass
class EntryLine:
    account: str
    debit_cents: int = 0
    credit_cents: int = 0
    memo: str = ""

    def wire(self) -> dict:
        return {"account": self.account, "debit_cents": self.debit_cents, "credit_cents": self.credit_cents, "memo": self.memo[:256]}


@dataclass
class Entry:
    """A provisional, balanced accrual for an incident. `recognition` says when it counts against the cap:
    a spare counts when first fitted, labour and freight when incurred, fines never (D5.1.1.m / Issue 22 Art. 3.1(m)),
    a destroyed part that was already in use was expensed when first used."""

    entry_key: str
    incident_key: str
    memo: str
    effective_date: str
    recognition: str
    cap_relevant: bool
    lines: list[EntryLine]
    effect_key: str = ""
    status: str = "proposed"  # proposed | approved | sealed
    evidence: list[str] = field(default_factory=list)  # event keys and URLs behind the entry
    at: str = ""

    def __post_init__(self) -> None:
        if self.recognition not in RECOGNITION:
            raise ValueError(f"unknown recognition {self.recognition!r}")
        dr = sum(line.debit_cents for line in self.lines)
        cr = sum(line.credit_cents for line in self.lines)
        if len(self.lines) < 2 or dr != cr:
            raise ValueError(f"entry {self.entry_key} does not balance: {dr} != {cr}")
        self.at = canonical(self.at) if self.at else now_iso()

    @property
    def amount_cents(self) -> int:
        return sum(line.debit_cents for line in self.lines)

    def wire(self) -> dict:
        return {"entry_key": self.entry_key, "incident_key": self.incident_key, "effect_key": self.effect_key, "memo": self.memo[:512],
                "effective_date": self.effective_date, "recognition": self.recognition, "cap_relevant": self.cap_relevant,
                "amount_cents": self.amount_cents, "status": self.status, "evidence_json": _j(self.evidence)[:2048], "at": self.at}

    def wire_lines(self) -> list[dict]:
        return [line.wire() for line in self.lines]


QUESTION_STATUSES = ("open", "answered", "defaulted")


@dataclass
class Question:
    """A question for a person. `options` are the answers on the buttons; for a damage question they are the two
    nearest precedents that ended differently, each with its band: [{"id", "label", "case_id", "severity", "band"}]."""

    question_key: str
    incident_key: str
    kind: str  # damage | decision | approval
    prompt: str
    options: list[dict]
    route_role: str
    expected_loss_cents: int = 0
    deadline_at: str = ""
    effect_keys: list[str] = field(default_factory=list)
    default_option: str = ""
    status: str = "open"
    answer: dict = field(default_factory=dict)
    answered_by: str = ""
    created_at: str = ""

    def __post_init__(self) -> None:
        if self.status not in QUESTION_STATUSES:
            raise ValueError(f"unknown question status {self.status!r}")
        self.deadline_at = canonical(self.deadline_at) if self.deadline_at else ""
        self.created_at = canonical(self.created_at) if self.created_at else now_iso()

    def wire(self) -> dict:
        return {"question_key": self.question_key, "incident_key": self.incident_key, "kind": self.kind, "prompt": self.prompt[:1024],
                "options_json": _j(self.options)[:4096], "route_role": self.route_role, "expected_loss_cents": self.expected_loss_cents,
                "deadline_at": self.deadline_at, "effect_keys": ",".join(self.effect_keys)[:1024], "default_option": self.default_option,
                "status": self.status, "answer_json": _j(self.answer)[:2048], "answered_by": self.answered_by, "created_at": self.created_at}


@dataclass
class SimRun:
    """One re-run of the season after the evidence changed. `payload` holds the position distribution, prize band,
    attribution, ATR, bonus and cap forecast (race/season_sim.py, race/cap_forecast.py)."""

    sim_key: str
    meeting_key: int
    trigger: str  # baseline | incident:<key> | result:<session> | answer:<key>
    at: str
    payload: dict
    runtime_ms: int = 0

    def wire(self) -> dict:
        return {"sim_key": self.sim_key, "meeting_key": self.meeting_key, "trigger": self.trigger[:256], "at": canonical(self.at),
                "payload_json": _j(self.payload)[:16384], "runtime_ms": self.runtime_ms}


@dataclass
class Close:
    """The sealed weekend: a Merkle root over every effect, entry and action, totals, and one brief per role."""

    close_key: str
    meeting_key: int
    closed_at: str
    root_hash: str
    totals: dict
    briefs: dict  # role -> markdown
    status: str = "draft"  # draft | approved | sent
    approved_by: str = ""
    leaves: int = 0

    def wire(self) -> dict:
        return {"close_key": self.close_key, "meeting_key": self.meeting_key, "closed_at": canonical(self.closed_at), "root_hash": self.root_hash,
                "totals_json": _j(self.totals)[:8192], "briefs_json": _j(self.briefs)[:32768], "status": self.status,
                "approved_by": self.approved_by, "leaves": self.leaves}


@dataclass
class OptionSet:
    """What each decision the pit wall has would do now for one car: stay out, pit now, other compound, the same stop
    under green. Each option carries its position range, time, money and cap effects; none is recommended."""

    option_key: str
    session_key: int
    meeting_key: int
    driver_number: int
    lap: int
    at: str
    condition: str  # green | sc | vsc | red
    trigger: str
    options: list[dict]

    def wire(self) -> dict:
        return {"option_key": self.option_key, "session_key": self.session_key, "meeting_key": self.meeting_key,
                "driver_number": self.driver_number, "lap": self.lap, "at": canonical(self.at), "condition": self.condition,
                "trigger": self.trigger, "options_json": _j(self.options)[:8192]}


POSTING_STATUSES = ("authorized", "posted", "held", "approved", "rejected", "failed")


@dataclass
class Posting:
    """Where one race entry went in the books: posted to the ERP, held for review, approved, rejected or failed."""

    entry_key: str
    incident_key: str
    status: str
    amount_cents: int
    reason: str
    erp_entry_id: str = ""
    cost_cap_ref: str = ""
    review_role: str = ""
    by: str = "race_desk"
    at: str = ""

    def __post_init__(self) -> None:
        if self.status not in POSTING_STATUSES:
            raise ValueError(f"unknown posting status {self.status!r}")
        self.at = canonical(self.at) if self.at else now_iso()

    def wire(self) -> dict:
        return {"entry_key": self.entry_key, "incident_key": self.incident_key, "status": self.status, "erp_entry_id": self.erp_entry_id,
                "cost_cap_ref": self.cost_cap_ref, "review_role": self.review_role, "reason": self.reason[:512],
                "amount_cents": self.amount_cents, "by": self.by, "at": self.at}
