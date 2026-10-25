"""The team's operations history: what it has swapped, built, shipped and booked before, as cases.

    store = OperationStore.load()                 # race/data/operations_2024.jsonl (+ what this weekend taught it)
    case, sim = store.match(view)                 # the closest case and how close, or (None, 0.0)
    store.learn_entry(...) / store.learn_action(...)   # a posted entry or an approved operation becomes a case

A response plan line (race/plan.py) executes on its own only when the team has done something very like it before:
the same operation on the same part, booked the same way, at an amount within a band of what it cost last time. There
is no amount threshold anywhere: a $1m monocoque posts if the team has booked a monocoque before, and a $40k wing is
held if it costs twice what a wing ever did. The band is what keeps a familiar operation at an unfamiliar price from
sliding through.

Similarity (0..1) is a weighted sum: the kind of operation (an entry, a reservation, a Grove work order, a freight
booking), the part, the account and recognition (for entries: when the cap counts it), and the amount against the
case's. A line matches when its best case scores at least MIN_SIMILARITY.

The 2024 cases are Williams' own season as the press recorded it (Melbourne, Suzuka, Zandvoort, Monza, Austin), priced
from the price book: parts and amounts are stated assumptions, the crashes and what was destroyed are reported.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from race import prices as P

DATA = Path(__file__).resolve().parent / "data"
STORE = DATA / "operations_2024.jsonl"
MIN_SIMILARITY = 0.8
AMOUNT_BAND = 0.35  # a line's amount may differ from the case's by this share before the amount score falls to zero
WEIGHTS = {"kind": 0.32, "part": 0.28, "books": 0.15, "amount": 0.25}
BOOKED_DIFFERENTLY = 0.6  # an entry on another account, or counted by the cap at another time, is another operation: capped here


@dataclass
class OpCase:
    case_id: str
    kind: str  # entry | spares_reserve | work_order | hand_carry | freight | td017_move | pu_check | parc_ferme_list | fia_notice | evidence_pack
    part: str = ""  # price-book part, or "" for an operation without one (labour, freight, a notice)
    account: str = ""  # entries: the expense account (6050, 5200, 6300, 6910)
    recognition: str = ""  # entries: first_use | incurred | excluded
    amount_cents: int = 0
    source: str = "history"  # history | weekend | decision
    summary: str = ""
    at: str = ""
    weekend: str = ""
    by: str = ""  # who approved it, when a person did

    def row(self) -> dict:
        return asdict(self)


def amount_score(a: int, b: int) -> float:
    """1 when the line costs what the case did or less, falling to 0 once it costs more than the band above it. The guard is
    one-sided on purpose: a familiar part at an unfamiliar price is what an auditor asks about; a probability-weighted
    booking below the part's usual price is not. A case with no amount scores a line with none."""
    if not a and not b:
        return 1.0
    if not b:
        return 0.0
    over = max(0, abs(a) - abs(b)) / abs(b)
    return max(0.0, 1.0 - over / AMOUNT_BAND)


def similarity(view: dict, case: OpCase) -> float:
    s = 0.0
    s += WEIGHTS["kind"] * (1.0 if view.get("kind") == case.kind else 0.0)
    s += WEIGHTS["part"] * (1.0 if (view.get("part") or "") == (case.part or "") else 0.0)
    booked_alike = True
    if view.get("kind") == "entry" or case.kind == "entry":
        same_acct = (view.get("account") or "") == (case.account or "")
        same_rec = (view.get("recognition") or "") == (case.recognition or "")
        booked_alike = same_acct and same_rec
        s += WEIGHTS["books"] * (0.5 * same_acct + 0.5 * same_rec)
    else:
        s += WEIGHTS["books"]
    s += WEIGHTS["amount"] * amount_score(int(view.get("amount_cents") or 0), int(case.amount_cents or 0))
    if not booked_alike:
        s = min(s, BOOKED_DIFFERENTLY)
    return round(min(s, 1.0), 4)


class OperationStore:
    def __init__(self, cases: list[OpCase] | None = None):
        self.cases: list[OpCase] = list(cases or [])

    @classmethod
    def load(cls, path: Path = STORE) -> "OperationStore":
        if not path.exists():
            return cls()
        out = []
        for line in path.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out.append(OpCase(**{k: v for k, v in d.items() if k in OpCase.__dataclass_fields__}))
        return cls(out)

    def save(self, path: Path = STORE) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(c.row(), separators=(",", ":")) + "\n" for c in self.cases))

    def __len__(self) -> int:
        return len(self.cases)

    def add(self, case: OpCase) -> None:
        self.cases = [c for c in self.cases if c.case_id != case.case_id] + [case]

    def nearest(self, view: dict, k: int = 5) -> list[tuple[float, OpCase]]:
        return sorted(((similarity(view, c), c) for c in self.cases), key=lambda x: -x[0])[:k]

    def match(self, view: dict, min_similarity: float = MIN_SIMILARITY) -> tuple[OpCase | None, float]:
        """The closest case when it is close enough, else (None, best score)."""
        best = self.nearest(view, 1)
        if not best:
            return None, 0.0
        sim, case = best[0]
        return (case, sim) if sim >= min_similarity else (None, sim)

    # ---------------------------------------------------------------- learning
    def learn_entry(self, entry_key: str, part: str, account: str, recognition: str, amount_cents: int, *, at: str, weekend: str, by: str, summary: str) -> OpCase:
        c = OpCase(case_id=f"{weekend}:{entry_key[:16]}:{part or account}", kind="entry", part=part, account=account, recognition=recognition,
                   amount_cents=int(amount_cents), source="weekend", summary=summary[:200], at=at, weekend=weekend, by=by)
        self.add(c)
        return c

    def learn_action(self, action_key: str, kind: str, part: str, amount_cents: int, *, at: str, weekend: str, by: str, summary: str) -> OpCase:
        c = OpCase(case_id=f"{weekend}:{action_key[:24]}:{part}", kind=kind, part=part, amount_cents=int(amount_cents), source="decision",
                   summary=summary[:200], at=at, weekend=weekend, by=by)
        self.add(c)
        return c

    def counts(self) -> dict:
        out: dict[str, int] = {}
        for c in self.cases:
            out[c.kind] = out.get(c.kind, 0) + 1
        return out


# ---------------------------------------------------------------- Williams 2024 as the press recorded it
# Each crash: the parts the team replaced (press where reported, the heavy template otherwise), where the spare came
# from, and the operations that followed. Amounts are the price book's mid in USD cents. No new monocoque was built
# mid-season (Melbourne's tub was repaired at Grove; Zandvoort used the spare built by Miami), so a "new monocoque"
# line in São Paulo has no case to match: that is the point.

SEASON_2024 = [
    {"id": "mel24-fp1-23", "at": "2024-03-22T02:10:00Z", "weekend": "Melbourne 2024", "car": 23, "flyaway": True,
     "summary": "Melbourne FP1, Albon: chassis broken at Turn 6; tub repaired at Grove, no spare (formula1.com)",
     "stock": ["front_wing", "floor", "front_suspension", "bodywork", "rear_wing"], "made": ["front_suspension"], "repair": True, "labour": "heavy"},
    {"id": "suz24-fp1-23", "at": "2024-04-05T02:45:00Z", "weekend": "Suzuka 2024", "car": 23, "flyaway": True,
     "summary": "Suzuka FP1, Albon: into the barrier at Turn 7; floor, wings and a rear corner replaced (formula1.com)",
     "stock": ["front_wing", "floor", "rear_wing", "rear_suspension", "bodywork"], "made": ["floor"], "repair": False, "labour": "moderate"},
    {"id": "suz24-fp1-2", "at": "2024-04-05T02:50:00Z", "weekend": "Suzuka 2024", "car": 2, "flyaway": True,
     "summary": "Suzuka FP1, Sargeant: heavy crash at Dunlop, car rebuilt overnight (racefans.net)",
     "stock": ["front_wing", "floor", "front_suspension", "rear_suspension", "bodywork", "electronics", "gearbox"], "made": ["gearbox"], "repair": False, "labour": "heavy"},
    {"id": "zan24-fp3-2", "at": "2024-08-24T10:55:00Z", "weekend": "Zandvoort 2024", "car": 2, "flyaway": False,
     "summary": "Zandvoort FP3, Sargeant: car destroyed at Turn 3; the spare tub built up, older-spec parts to protect stock (racefans.net)",
     "stock": ["chassis_spare", "front_wing", "floor", "rear_wing", "front_suspension", "rear_suspension", "bodywork", "electronics", "gearbox"], "made": ["floor", "rear_wing"], "repair": False, "labour": "heavy"},
    {"id": "mza24-fp2-2", "at": "2024-08-30T14:20:00Z", "weekend": "Monza 2024", "car": 2, "flyaway": False,
     "summary": "Monza FP2, Sargeant: spin into the gravel, front wing and floor edge replaced (assumption from the session report)",
     "stock": ["front_wing", "bodywork"], "made": [], "repair": False, "labour": "light"},
    {"id": "cota24-q-23", "at": "2024-10-19T22:15:00Z", "weekend": "Austin 2024", "car": 23, "flyaway": True,
     "summary": "Austin qualifying, Albon: brush with the wall, rear wing and bodywork replaced for the sprint (assumption)",
     "stock": ["rear_wing", "bodywork", "rear_suspension"], "made": [], "repair": False, "labour": "light"},
]


def _usd(part: str) -> int:
    return P.PARTS[part].usd_cents()[1]


def build_2024_cases() -> list[OpCase]:
    out: list[OpCase] = []
    for c in SEASON_2024:
        pre = f"press-{c['id']}"
        who = f"Williams 2024, car {c['car']}"
        for part in c["stock"]:
            job = "chassis" if part == "chassis_spare" else part
            out.append(OpCase(f"{pre}:fit:{job}", "entry", job, "6050", "first_use", _usd(job), "history", f"{c['weekend']}: {P.PART_LABELS.get(job, job)} fitted from spares ({who})", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:reserve:{job}", "spares_reserve", job, "", "", _usd(job), "history", f"{c['weekend']}: {P.PART_LABELS.get(job, job)} reserved from stock", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:move:{job}", "td017_move", job, "", "", 0, "history", f"{c['weekend']}: inventory move, {P.PART_LABELS.get(job, job)}", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:rebuild:{job}", "work_order", job, "", "", _usd(job), "history", f"{c['weekend']}: Grove rebuilt the {P.PART_LABELS.get(job, job)} for the next event", c["at"], c["weekend"]))
        for part in c["made"]:
            out.append(OpCase(f"{pre}:make:{part}", "entry", part, "6050", "incurred", _usd(part), "history", f"{c['weekend']}: {P.PART_LABELS.get(part, part)} made new, none in stock ({who})", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:reserve-make:{part}", "spares_reserve", part, "", "", _usd(part), "history", f"{c['weekend']}: {P.PART_LABELS.get(part, part)} to be made, none at track or Grove", c["at"], c["weekend"]))
        if c["repair"]:
            out.append(OpCase(f"{pre}:repair:chassis", "entry", "chassis_repair", "6050", "incurred", _usd("chassis_repair"), "history", f"{c['weekend']}: chassis repaired at Grove ({who})", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:wo:chassis_repair", "work_order", "chassis_repair", "", "", _usd("chassis_repair"), "history", f"{c['weekend']}: Grove repaired the tub", c["at"], c["weekend"]))
        lab = P.REPAIR_LABOUR[c["labour"]].usd_cents()[1]
        if lab:
            out.append(OpCase(f"{pre}:labour", "entry", "", "5200", "incurred", lab, "history", f"{c['weekend']}: repair labour, {c['labour']} ({who})", c["at"], c["weekend"]))
        if c["flyaway"]:
            fr = P.EXPEDITED_FREIGHT.usd_cents()[1]
            out.append(OpCase(f"{pre}:freight", "entry", "", "6300", "incurred", fr, "history", f"{c['weekend']}: air freight of replacement parts ({who})", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:book-freight", "freight", "", "", "", fr, "history", f"{c['weekend']}: air freight booked to the next flyaway", c["at"], c["weekend"]))
            out.append(OpCase(f"{pre}:hand-carry", "hand_carry", "", "", "", fr, "history", f"{c['weekend']}: parts hand-carried to the next event", c["at"], c["weekend"]))
        out.append(OpCase(f"{pre}:pu_check", "pu_check", "", "", "", 0, "history", f"{c['weekend']}: power unit and gearbox checked after the crash", c["at"], c["weekend"]))
        out.append(OpCase(f"{pre}:parc_ferme", "parc_ferme_list", "", "", "", 0, "history", f"{c['weekend']}: parc fermé list for the Technical Delegate", c["at"], c["weekend"]))
        out.append(OpCase(f"{pre}:fia_notice", "fia_notice", "", "", "", 0, "history", f"{c['weekend']}: notice to the FIA", c["at"], c["weekend"]))
        out.append(OpCase(f"{pre}:evidence", "evidence_pack", "", "", "", 0, "history", f"{c['weekend']}: evidence pack for the cost cap submission", c["at"], c["weekend"]))
    return out


def write_2024(path: Path = STORE) -> int:
    """Write Williams' 2024 cases; `python -m race.history` does it."""
    cases = build_2024_cases()
    OperationStore(cases).save(path)
    return len(cases)


if __name__ == "__main__":
    print(f"wrote {write_2024()} cases to {STORE}")
