"""Precedents: what this team did last time something very like this happened.

The learned tier that leads. Every historical case (onboarding over 2025-26 sessions) and every human
correction becomes a `Case` with a small feature vector. For a new event the store finds the nearest cases;
when enough of them are very similar and agree on the outcome, that outcome is the protocol and it runs on
its own authority (`decided_by = precedent:<case ids>`). No model call, no waiting for a grant: the team
has done this before, scored the same, and the books move the same way.

    store = PrecedentStore.load()                      # race/data/precedents.jsonl
    match = store.match(flat_view(event, context))     # PrecedentMatch | None
    match.outcome, match.similarity, match.cases, match.effect_template()

Similarity (0..1) is a weighted sum over: kind, the stewards' reason words, whether the car retired within
two laps, whether it pitted straight after, the track status, whether damage was likely, and the
compound/tyre age bucket for pit stops. Thresholds are deliberately strict: a protocol fires only when the
top cases are near-identical (>= 0.85) and at least three of them agree (>= 80%).
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

STORE = Path(__file__).resolve().parent / "data" / "precedents.jsonl"
MIN_SIMILARITY = 0.85
MIN_CASES = 3
MIN_AGREEMENT = 0.8
K = 7
STOPWORDS = {"THE", "A", "AN", "AND", "OF", "AT", "IN", "TO", "FOR", "WITH", "CAR", "CARS", "INCIDENT", "INVOLVING", "NOTED"}
OUTCOMES = ("heavy", "moderate", "light", "none", "free_stop", "tyre_set")


@dataclass
class Case:
    case_id: str
    kind: str
    outcome: str  # heavy | moderate | light | none | free_stop | tyre_set
    reason: str = ""
    retired_within_laps: int | None = None
    pit_within_laps: int | None = None
    under: str = "green"
    damage_likely: bool = False
    compound: str = ""
    tyre_age: int | None = None
    source: str = "history"  # history | correction
    session_key: int = 0
    car: int = 0
    lap: int = 0
    summary: str = ""
    cost_cents: list[int] = field(default_factory=list)  # [low, mid, high] when the case carries a booked band (corrections)

    def row(self) -> dict:
        return asdict(self)


def _tokens(reason: str) -> set[str]:
    return {t for t in re.findall(r"[A-Z]+", (reason or "").upper()) if t not in STOPWORDS and len(t) > 2}


def _bucket_laps(n: int | None) -> str:
    if n is None:
        return "no"
    return "0-2" if n <= 2 else "3+"


def _bucket_age(n: int | None) -> str:
    if n is None:
        return "?"
    return "new" if n == 0 else "used" if n < 15 else "old"


WEIGHTS = {"kind": 0.30, "reason": 0.20, "retired": 0.18, "pit": 0.10, "under": 0.08, "damage": 0.08, "tyre": 0.06}


def similarity(view: dict, case: Case) -> float:
    """0..1; 1 means the stored case scored exactly like this event."""
    s = 0.0
    s += WEIGHTS["kind"] * (1.0 if view.get("kind") == case.kind else 0.0)
    a, b = _tokens(view.get("reason") or ""), _tokens(case.reason)
    if not a and not b:
        s += WEIGHTS["reason"]
    elif a or b:
        s += WEIGHTS["reason"] * (len(a & b) / len(a | b))
    s += WEIGHTS["retired"] * (1.0 if _bucket_laps(view.get("retired_within_laps")) == _bucket_laps(case.retired_within_laps) else 0.0)
    s += WEIGHTS["pit"] * (1.0 if _bucket_laps(view.get("pit_within_laps")) == _bucket_laps(case.pit_within_laps) else 0.0)
    vu, cu = (view.get("under") or "green"), (case.under or "green")
    s += WEIGHTS["under"] * (1.0 if vu == cu else 0.5 if {vu, cu} <= {"sc", "vsc"} else 0.0)
    s += WEIGHTS["damage"] * (1.0 if bool(view.get("damage_likely")) == case.damage_likely else 0.0)
    if view.get("kind") == "pit_stop" or case.kind == "pit_stop":
        same_c = (view.get("compound") or "") == (case.compound or "") or not case.compound
        same_age = _bucket_age(view.get("tyre_age")) == _bucket_age(case.tyre_age) or case.tyre_age is None
        s += WEIGHTS["tyre"] * (0.5 * same_c + 0.5 * same_age)
    else:
        s += WEIGHTS["tyre"]
    return round(min(s, 1.0), 4)


@dataclass
class PrecedentMatch:
    outcome: str
    similarity: float  # mean similarity of the agreeing cases
    agreement: float
    cases: list[Case]
    all_considered: int

    @property
    def case_ids(self) -> list[str]:
        return [c.case_id for c in self.cases]

    def effect_template(self) -> dict:
        if self.outcome in ("heavy", "moderate", "light"):
            bands = [c.cost_cents for c in self.cases if c.cost_cents]
            if len(bands) >= 2:  # corrected cases carry what the team actually booked
                mids = sorted(b[1] for b in bands)
                lows = sorted(b[0] for b in bands)
                highs = sorted(b[2] for b in bands)
                return {"cost_cents": [lows[len(lows) // 2], mids[len(mids) // 2], highs[len(highs) // 2]], "bucket": "6050", "severity": self.outcome}
            return {"severity": self.outcome}
        return {"cost": 0}

    def why(self) -> str:
        ids = ", ".join(c.summary[:60] or c.case_id for c in self.cases[:3])
        return (f"Precedent: {len(self.cases)} near-identical cases (similarity {self.similarity:.2f}, {self.agreement:.0%} agree) "
                f"ended {self.outcome}: {ids}.")


class PrecedentStore:
    def __init__(self, cases: list[Case] | None = None):
        self.cases: list[Case] = list(cases or [])

    @classmethod
    def load(cls, path: Path = STORE) -> "PrecedentStore":
        if not path.exists():
            return cls()
        out = []
        for line in path.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out.append(Case(**{k: v for k, v in d.items() if k in Case.__dataclass_fields__}))
        return cls(out)

    def save(self, path: Path = STORE) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(c.row(), separators=(",", ":")) + "\n" for c in self.cases))

    def add(self, case: Case) -> None:
        self.cases = [c for c in self.cases if c.case_id != case.case_id] + [case]

    def __len__(self) -> int:
        return len(self.cases)

    def nearest(self, view: dict, k: int = K) -> list[tuple[float, Case]]:
        scored = sorted(((similarity(view, c), c) for c in self.cases), key=lambda x: -x[0])
        return scored[:k]

    def match(self, view: dict, k: int = K, min_similarity: float = MIN_SIMILARITY, min_cases: int = MIN_CASES,
              min_agreement: float = MIN_AGREEMENT) -> PrecedentMatch | None:
        close = [(s, c) for s, c in self.nearest(view, k) if s >= min_similarity]
        if len(close) < min_cases:
            return None
        votes = Counter(c.outcome for _, c in close)
        outcome, n = votes.most_common(1)[0]
        agreement = n / len(close)
        if agreement < min_agreement:
            return None
        agreeing = [(s, c) for s, c in close if c.outcome == outcome]
        return PrecedentMatch(outcome, round(sum(s for s, _ in agreeing) / len(agreeing), 4), round(agreement, 3),
                              [c for _, c in agreeing], len(close))

    def counts(self) -> dict:
        return dict(Counter(f"{c.kind}:{c.outcome}" for c in self.cases))


def wilson_lower(successes: int, n: int, z: float = 1.645) -> float:
    """Lower bound of the 90% Wilson interval: how consistent a rule is, discounted for how little we have seen."""
    if n == 0:
        return 0.0
    p = successes / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    spread = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (centre - spread) / denom)
