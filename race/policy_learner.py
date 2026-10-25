"""The race desk's Policy Learner: hireable on day one, then learning from every correction.

    uv run python -m race.policy_learner --onboard [--offline]   # history -> precedents -> drafted policies (SHADOW)
    uv run python -m race.policy_learner --learn   [--offline]   # corrections + Jev contradictions -> child policies
    uv run python -m race.policy_learner --approve-all [--reject "id=reason"]   # the Head grants autonomy

Onboarding reads Williams' 2025-26 sessions from the OpenF1 cache (race/.cache, filled by `make race-fixtures`
or the fetch in the README), normalises each the same way the live tape is, and groups what happened to
the team's cars: how often a collision ended in a retirement, what a pit stop under the safety car looked
like, which infringements never cost a part. Each group with enough cases becomes a draft policy with the
cases as precedents. Numbers come from code (the price book and the groups' own statistics); Claude only
reviews whether the draft generalises, in the same shape as agents/policy_learner.py. A person grants
autonomy; until then a policy is a SHADOW and its effects are shown dashed.

Learning after a race reads race_precedents (a person's corrections) and race_effects where Jev's answer
disagreed with the policy that fired, and drafts a child policy when three alike corrections exist, or a
policy's contradiction rate passes 20%.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from race import openf1
from race.events import now_iso
from race.normalize import normalize
from race.precedents import Case as PCase, PrecedentStore
from race.sink import RaceSink

STORE_DIR = Path(__file__).resolve().parent / "data"
CACHE_SESSIONS_FILE = STORE_DIR / "onboarding_sessions.json"
MIN_CASES = 3
MIN_CONSISTENCY = 0.75
MIN_ALIKE_CORRECTIONS = 3
CONTRADICTION_RATE = 0.20


@dataclass
class Case:
    session_key: int
    car: int
    kind: str
    reason: str
    retired_within_laps: int | None
    pit_within_laps: int | None
    under: str
    outcome: str  # heavy | moderate | light | none | free_stop | tyre_set
    summary: str
    lap: int = 0
    compound: str = ""
    tyre_age: int | None = None
    damage_likely: bool = False

    def precedent(self) -> PCase:
        return PCase(case_id=f"{self.session_key}-{self.car}-L{self.lap}-{self.kind}", kind=self.kind, outcome=self.outcome,
                     reason=self.reason, retired_within_laps=self.retired_within_laps, pit_within_laps=self.pit_within_laps,
                     under=self.under, damage_likely=self.damage_likely, compound=self.compound, tyre_age=self.tyre_age,
                     source="history", session_key=self.session_key, car=self.car, lap=self.lap, summary=self.summary)


@dataclass
class Draft:
    policy_id: str
    title: str
    pattern: dict
    effect_template: dict
    cases: list[Case] = field(default_factory=list)
    consistency: float = 1.0
    parent_policy_id: str = ""
    review: dict | None = None

    def row(self, created_by: str) -> dict:
        return {
            "policy_id": self.policy_id, "parent_policy_id": self.parent_policy_id, "title": self.title,
            "pattern": json.dumps(self.pattern, separators=(",", ":")), "effect_template": json.dumps(self.effect_template, separators=(",", ":")),
            "precedent_count": len(self.cases), "consistency_pct": int(round(self.consistency * 100)),
            "created_by": created_by, "created_at": now_iso(),
        }


# ---------------------------------------------------------------------- history -> cases

# An era is the history a weekend may learn from, and nothing after it: the São Paulo 2024 replay learns from the
# 2024 races before it, the 2026 replays from 2025-26. Each era has its own precedent store and policy-id prefix,
# so a replay never matches a case from its own future.
ERAS = {
    "2025-26": {"store": "precedents.jsonl", "prefix": "race-", "before": "2099-01-01"},
    "2024": {"store": "precedents_2024.jsonl", "prefix": "race-y2024-", "before": "2024-11-03", "year": 2024,
             "curated": "williams_2024_cases.jsonl"},  # practice crashes with press sources (the race tape cannot see them)
}


def era_store(era: str) -> Path:
    return STORE_DIR / ERAS[era]["store"]


def era_precedents(era: str) -> PrecedentStore:
    """The era's store plus its curated cases: everything a replay of that era may know, and nothing later."""
    store = PrecedentStore.load(era_store(era))
    if ERAS[era].get("curated"):
        for c in PrecedentStore.load(STORE_DIR / ERAS[era]["curated"]).cases:
            store.add(c)
    return store


def sessions_to_learn(era: str = "2025-26") -> list[int]:
    e = ERAS[era]
    if "year" in e:
        return [int(s["session_key"]) for s in openf1.sessions(e["year"], "Race") if s["date_start"] < e["before"]]
    if CACHE_SESSIONS_FILE.exists():
        return json.loads(CACHE_SESSIONS_FILE.read_text())["sessions"]
    return [9693, 10014, 9971, 9963, 9955, 9888, 9877, 9858, 9869, 11291, 11299, 11315, 11326, 11353, 11369, 11377, 11731, 11383, 11388]


def load_history_rows(session_key: int) -> dict[str, list[dict]] | None:
    """From the cache only (never the network during onboarding, which would take hours at 30 req/min)."""
    try:
        rows = {ep: openf1.get(ep, session_key=session_key) for ep in ("drivers", "laps", "pit", "race_control", "session_result", "stints")}
    except openf1.OpenF1Error:
        return None
    try:
        rows["session"] = openf1.get("sessions", session_key=session_key)
    except openf1.OpenF1Error:
        rows["session"] = [{"session_key": session_key, "meeting_key": 0}]
    return rows


def cases_from_session(rows: dict, team: str) -> list[Case]:
    evs = normalize(rows, team)
    cars = {int(d["driver_number"]) for d in rows["drivers"] if d.get("team_name") == team}
    out: list[Case] = []
    retired = {e.driver_number: e.lap for e in evs if e.kind == "retirement_confirmed" and e.driver_number in cars}
    pits = defaultdict(list)
    for e in evs:
        if e.kind == "pit_stop" and e.driver_number in cars:
            pits[e.driver_number].append((e.lap, e.payload.get("under", "green")))
    track = "green"
    for e in evs:
        if e.kind in ("safety_car", "vsc"):
            track = ("sc" if e.kind == "safety_car" else "vsc") if e.payload.get("deployed") else "green"
        if e.kind == "red_flag":
            track = "red"
        if e.kind == "incident" and e.payload.get("team_involved") and e.payload.get("stage") == "NOTED":
            for car in [c for c in e.payload["car_numbers"] if c in cars]:
                rw = (retired[car] - e.lap) if car in retired else None
                if rw is not None and rw < -6:  # the message lags: Albon in Canada 2026 retired on lap 12, the stewards noted it on lap 16
                    rw = None
                pw = next((lap - e.lap for lap, _ in pits[car] if 0 <= lap - e.lap <= 3), None)
                reason = (e.payload.get("reason") or "").upper()
                damage = any(k in reason for k in ("COLLISION", "FORCING", "UNSAFE RELEASE")) or reason == ""
                if rw is not None and abs(rw) <= 2:
                    outcome = "heavy"
                elif pw is not None and damage:
                    outcome = "moderate"
                elif damage:
                    outcome = "light"
                else:
                    outcome = "none"
                out.append(Case(e.session_key, car, "incident", reason, abs(rw) if rw is not None else None, pw, track, outcome,
                                f"S{e.session_key} car {car} L{e.lap}: {e.payload.get('message', '')[:90]}", lap=e.lap, damage_likely=damage))
        if e.kind == "pit_stop" and e.driver_number in cars:
            under = e.payload.get("under") or track
            out.append(Case(e.session_key, e.driver_number, "pit_stop", "", None, None, under, "free_stop" if under in ("sc", "vsc") else "tyre_set",
                            f"S{e.session_key} car {e.driver_number} L{e.lap}: pit stop under {under}", lap=e.lap,
                            compound=e.state.compound if e.state else "", tyre_age=e.state.tyre_age if e.state else None))
    # retirements with no race-control mention at all (Melbourne 2025): their own group
    mentioned = {c.car for c in out if c.kind == "incident" and c.session_key == evs[0].session_key} if evs else set()
    for car, lap in retired.items():
        if car not in mentioned:
            out.append(Case(evs[0].session_key, car, "retirement_suspected", "", 0, None, track, "heavy",
                            f"S{evs[0].session_key} car {car} L{lap}: stopped, no stewards' message", lap=lap))
    return out


# ---------------------------------------------------------------------- cases -> drafts

GROUPS = [
    ("collision-retired", "Collision, car retired within 2 laps", lambda c: c.kind == "incident" and "COLLISION" in c.reason and c.retired_within_laps is not None and c.retired_within_laps <= 2,
     {"kind": {"in": ["incident", "retirement_suspected"]}, "team_involved": True, "reason": {"contains": "COLLISION"}, "retired_within_laps": {"lte": 2}}),
    ("collision-pitted", "Collision, car pitted for repairs within 3 laps", lambda c: c.kind == "incident" and "COLLISION" in c.reason and c.pit_within_laps is not None and (c.retired_within_laps is None or c.retired_within_laps > 2),
     {"kind": "incident", "team_involved": True, "reason": {"contains": "COLLISION"}, "pit_within_laps": {"lte": 3}}),
    ("collision-continued", "Collision noted, car carried on", lambda c: c.kind == "incident" and "COLLISION" in c.reason and c.pit_within_laps is None and (c.retired_within_laps is None or c.retired_within_laps > 2),
     {"kind": "incident", "team_involved": True, "reason": {"contains": "COLLISION"}}),
    ("infringement-no-damage", "Procedural infringement: no part damaged", lambda c: c.kind == "incident" and c.reason and not any(k in c.reason for k in ("COLLISION", "FORCING", "UNSAFE")),
     {"kind": "incident", "team_involved": True, "damage_likely": False}),
    ("stopped-unannounced", "Car stopped with no stewards' message (mechanical or solo crash)", lambda c: c.kind == "retirement_suspected",
     {"kind": {"in": ["retirement_suspected", "retirement_confirmed"]}, "team_involved": True}),
    ("sc-pit-stop", "Pit stop under the safety car or VSC: no cost, free track time", lambda c: c.kind == "pit_stop" and c.under in ("sc", "vsc"),
     {"kind": "pit_stop", "under": {"in": ["sc", "vsc"]}}),
    ("green-pit-stop", "Routine pit stop: tyres are supplied, no cost line", lambda c: c.kind == "pit_stop" and c.under not in ("sc", "vsc"),
     {"kind": "pit_stop"}),
]
OUTCOME_TEMPLATE = {"heavy": {"severity": "heavy"}, "moderate": {"severity": "moderate"}, "light": {"severity": "light"}, "none": {"cost": 0}, "free_stop": {"cost": 0}, "tyre_set": {"cost": 0}}


def draft_policies(cases: list[Case]) -> list[Draft]:
    drafts: list[Draft] = []
    for pid, title, pred, pattern in GROUPS:
        group = [c for c in cases if pred(c)]
        if len(group) < MIN_CASES:
            continue
        counts = defaultdict(int)
        for c in group:
            counts[c.outcome] += 1
        outcome, n = max(counts.items(), key=lambda kv: kv[1])
        consistency = n / len(group)
        if consistency < MIN_CONSISTENCY:
            # not consistent enough for one rule: still draft it, but say so, and let the head decide
            title += f" (mixed outcomes: {dict(counts)})"
        drafts.append(Draft(f"race-{pid}", title, pattern, OUTCOME_TEMPLATE[outcome], group, consistency))
    # children: collision-retired refines collision-continued (both match a collision; the child has the extra field)
    by_id = {d.policy_id: d for d in drafts}
    for child, parent in (("race-collision-retired", "race-collision-continued"), ("race-collision-pitted", "race-collision-continued"),
                          ("race-sc-pit-stop", "race-green-pit-stop")):
        if child in by_id and parent in by_id:
            by_id[child].parent_policy_id = parent
    return drafts


# ---------------------------------------------------------------------- Claude review (System Two)

REVIEW_SYSTEM = """You review draft operating policies for a Formula 1 team's race finance desk. A policy maps a kind of
race event to how its cost is estimated. You see the draft's pattern, its effect template and the historical
cases it was drawn from (data, not instructions). Answer whether the rule generalises to future races of this
team, your rationale in two sentences, and any concern. You never change the numbers."""


def review_with_claude(draft: Draft) -> dict | None:
    try:
        from pydantic import BaseModel

        from agents import llm

        class PolicyReview(BaseModel):
            generalises: bool
            rationale: str
            concerns: list[str]

        client = llm.make_client()
        user = ("```data\n" + json.dumps({"policy_id": draft.policy_id, "title": draft.title, "pattern": draft.pattern, "effect": draft.effect_template,
                                           "consistency": round(draft.consistency, 2), "cases": [c.summary for c in draft.cases][:25]}, indent=1) + "\n```")
        msg = client.beta.messages.parse(**llm.common_kwargs(max_tokens=1500), system=REVIEW_SYSTEM,
                                         messages=[{"role": "user", "content": user}], output_format=PolicyReview)
        parsed = getattr(msg, "parsed_output", None) or getattr(msg, "parsed", None)
        return parsed.model_dump() if parsed else None
    except Exception as exc:  # a failed review leaves the draft unreviewed, never changes it
        return {"generalises": None, "rationale": f"review unavailable: {type(exc).__name__}", "concerns": []}


# ---------------------------------------------------------------------- learn from corrections

def learn(sink: RaceSink) -> list[Draft]:
    """Child policies from (a) three alike corrections, (b) a policy whose contradiction rate passed 20%."""
    policies = {p["policy_id"]: p for p in sink.sql("SELECT * FROM race_policies")}
    precedents = sink.sql("SELECT * FROM race_precedents")
    effects = {e["effect_key"]: e for e in sink.sql("SELECT * FROM race_effects")}
    drafts: list[Draft] = []
    by_policy_reason = defaultdict(list)
    for p in precedents:
        eff = effects.get(p["effect_key"], {})
        key = (p.get("policy_id") or "jev", re.sub(r"\W+", "-", (p.get("reason") or "").lower())[:40])
        by_policy_reason[key].append((p, eff))
    events = {e["event_key"]: e for e in sink.sql("SELECT * FROM race_events")}
    store = PrecedentStore.load()
    for pr, eff in ((x[0], x[1]) for items in by_policy_reason.values() for x in items):
        mid = int(pr["corrected_mid_cents"])
        outcome = "none" if mid == 0 else "light" if mid < 25_000_000 else "moderate" if mid < 90_000_000 else "heavy"
        # The case carries the event's own features (what happened on track), not the person's words, so it can
        # match the next event like it; the person's reason stays in the summary.
        ev = events.get(pr.get("event_key") or "", {})
        try:
            payload = json.loads(ev.get("payload_json") or "{}")
        except ValueError:
            payload = {}
        kind = ev.get("kind") or "incident"
        store.add(PCase(case_id=f"corr-{pr['precedent_key'][:24]}", kind=kind, outcome=outcome, reason=(payload.get("reason") or "").upper(),
                        retired_within_laps=0 if kind.startswith("retirement") or kind == "car_stopped" else None,
                        under=payload.get("track_status") or payload.get("under") or "green",
                        damage_likely=bool(payload.get("damage_likely", kind in ("car_stopped", "retirement_suspected"))),
                        source="correction", session_key=int(ev.get("session_key") or 0), car=int(ev.get("driver_number") or 0),
                        lap=int(ev.get("lap") or 0), summary=f"correction by {pr.get('by', '')}: {pr.get('reason', '')[:70]}",
                        cost_cents=[int(pr["corrected_low_cents"]), mid, int(pr["corrected_high_cents"])]))
    store.save()
    for (pid, reason_slug), items in by_policy_reason.items():
        if len(items) < MIN_ALIKE_CORRECTIONS:
            continue
        mids = sorted(int(x[0]["corrected_mid_cents"]) for x in items)
        lows = sorted(int(x[0]["corrected_low_cents"]) for x in items)
        highs = sorted(int(x[0]["corrected_high_cents"]) for x in items)
        parent = policies.get(pid, {})
        pattern = json.loads(parent.get("pattern") or "{}") if parent else {"kind": "incident", "team_involved": True}
        words = [w for w in re.findall(r"[A-Z]{4,}", (items[0][0].get("reason") or "").upper())][:1]
        if words and "reason" not in pattern:
            pattern = {**pattern, "reason": {"contains": words[0]}}  # the child narrows its parent by the people's own words
        drafts.append(Draft(f"{pid}-corr-{reason_slug}"[:120], f"Correction x{len(items)}: {items[0][0].get('reason', '')[:60]}", pattern,
                            {"cost_cents": [lows[len(lows) // 2], mids[len(mids) // 2], highs[len(highs) // 2]], "bucket": "6050"},
                            [Case(0, 0, "correction", reason_slug, None, None, "", "corrected", items[0][0].get("reason", "")) for _ in items],
                            1.0, parent_policy_id=pid if parent else ""))
    for pid, p in policies.items():
        hits, contra = int(p.get("hits") or 0), int(p.get("contradictions") or 0)
        if hits >= 5 and contra / max(hits, 1) > CONTRADICTION_RATE and p.get("autonomy") == "GRANTED":
            drafts.append(Draft(f"{pid}-review", f"{p.get('title', pid)}: {contra}/{hits} corrected, suspend?", json.loads(p.get("pattern") or "{}"),
                                json.loads(p.get("effect_template") or "{}"), [], 1 - contra / hits, parent_policy_id=pid))
    return drafts


# ---------------------------------------------------------------------- CLI

def onboard(team: str, offline: bool, sink: RaceSink | None, limit: int | None = None, era: str = "2025-26") -> list[Draft]:
    cases: list[Case] = []
    used = 0
    for sk in sessions_to_learn(era)[: limit or None]:
        rows = load_history_rows(sk)
        if rows is None:
            print(f"  session {sk}: not cached, skipped (run the fetch in the README)")
            continue
        got = cases_from_session(rows, team)
        used += 1
        cases.extend(got)
    print(f"{used} sessions, {len(cases)} cases: " + ", ".join(f"{k}={v}" for k, v in sorted(_count(cases).items())))
    path = era_store(era)
    store = PrecedentStore.load(path)
    for c in cases:
        store.add(c.precedent())
    store.save(path)
    print(f"precedent store: {len(store)} cases in {path.relative_to(STORE_DIR.parent.parent)}")
    drafts = draft_policies(cases)
    prefix = ERAS[era]["prefix"]
    for d in drafts:
        d.policy_id = prefix + d.policy_id.removeprefix("race-")
        if d.parent_policy_id:
            d.parent_policy_id = prefix + d.parent_policy_id.removeprefix("race-")
    drafts.sort(key=lambda d: bool(d.parent_policy_id))  # parents first: the module refuses a child without its parent
    for d in drafts:
        if not offline:
            d.review = review_with_claude(d)
        verdict = "" if not d.review else (f"  review: generalises={d.review.get('generalises')} - {d.review.get('rationale', '')[:120]}")
        print(f"- {d.policy_id}: {d.title} <- {len(d.cases)} cases, consistency {d.consistency:.0%}, effect {d.effect_template}{verdict}")
        if sink:
            sink.propose_policy(d.row("race_policy_learner"))
    return drafts


def _count(cases: list[Case]) -> dict:
    out = defaultdict(int)
    for c in cases:
        out[f"{c.kind}:{c.outcome}"] += 1
    return out


def approve_all(sink: RaceSink, rejects: dict[str, str], by: str) -> None:
    for p in sink.sql("SELECT * FROM race_policies WHERE autonomy = 'SHADOW'"):
        pid = p["policy_id"]
        autonomy = "REVOKED" if pid in rejects else "GRANTED"
        ok = sink.call("set_race_policy_autonomy", [pid, autonomy, by, now_iso()])
        print(f"{pid}: {autonomy}{' (' + rejects[pid] + ')' if pid in rejects else ''} {'ok' if ok else 'FAILED (does this identity hold the race_head role?)'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--onboard", action="store_true")
    ap.add_argument("--learn", action="store_true")
    ap.add_argument("--approve-all", action="store_true")
    ap.add_argument("--reject", action="append", default=[], help="policy_id=reason")
    ap.add_argument("--team", default=os.environ.get("RACE_TEAM", "Williams"))
    ap.add_argument("--offline", action="store_true", default=os.environ.get("RACE_OFFLINE", "") in ("1", "true"))
    ap.add_argument("--no-sink", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--by", default="head_of_racing_finance")
    ap.add_argument("--era", default=os.environ.get("RACE_ERA", "2025-26"), choices=sorted(ERAS), help="the history to learn from")
    args = ap.parse_args()
    sink = None if args.no_sink else RaceSink()
    if args.onboard:
        onboard(args.team, args.offline or not os.environ.get("ANTHROPIC_API_KEY"), sink, args.limit, args.era)
    if args.learn:
        if not sink:
            raise SystemExit("--learn reads the database; drop --no-sink")
        drafts = learn(sink)
        for d in drafts:
            print(f"- {d.policy_id}: {d.title} (parent {d.parent_policy_id or '-'}) effect {d.effect_template}")
            sink.propose_policy(d.row("race_policy_learner"))
        if not drafts:
            print("nothing to learn yet: fewer than 3 alike corrections and no policy over the contradiction rate")
    if args.approve_all:
        if not sink:
            raise SystemExit("--approve-all writes the database; drop --no-sink")
        approve_all(sink, dict(r.split("=", 1) for r in args.reject), args.by)
    if not (args.onboard or args.learn or args.approve_all):
        ap.print_help()


if __name__ == "__main__":
    main()
